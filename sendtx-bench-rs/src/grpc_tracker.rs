use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use futures::SinkExt;
use futures::stream::StreamExt;
use solana_sdk::signature::Signature;
use tokio::runtime::Runtime;
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::prelude::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterBlocks,
    SubscribeRequestFilterSlots, SubscribeRequestFilterTransactions,
    SubscribeRequestPing, subscribe_update::UpdateOneof,
};

#[derive(Clone, Copy, Debug)]
enum SubscriberRole {
    /// Single-endpoint mode: slots + transactions + blocks.
    All,
    /// Primary endpoint when a separate tracking endpoint is configured: blocks only
    /// (used solely for index-in-block resolution, since Aperture doesn't expose blocks).
    BlocksOnly,
    /// Dedicated tracking endpoint (e.g. rpcfast Aperture): slots + transactions
    /// (Aperture is ~30-40ms faster than vanilla Yellowstone for both).
    SlotsAndTransactions,
}

#[derive(Debug, Clone)]
pub enum LandingEvent {
    Transaction {
        slot: u64,
        local_received_ms: f64,
        grpc_created_at_ms: Option<f64>,
        err: Option<String>,
    },
    Block {
        slot: u64,
        index_in_block: usize,
        local_received_ms: f64,
        grpc_created_at_ms: Option<f64>,
    },
}

struct PendingEntry {
    submit_started: Instant,
    submit_wall: SystemTime,
    sender: mpsc::Sender<LandingEvent>,
}

pub struct GrpcTracker {
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    slot_state: Arc<(Mutex<u64>, Condvar)>,
    runtime: Option<Runtime>,
}

pub struct PendingHandle {
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    signature: String,
    pub receiver: mpsc::Receiver<LandingEvent>,
}

impl Drop for PendingHandle {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.pending.lock() {
            guard.remove(&self.signature);
        }
    }
}

impl GrpcTracker {
    pub fn new(
        primary_endpoint: String,
        primary_x_token: Option<String>,
        tracking_endpoint: Option<String>,
        tracking_x_token: Option<String>,
        sender_pubkeys: Vec<String>,
    ) -> Result<Self> {
        let pending: Arc<Mutex<HashMap<String, PendingEntry>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let slot_state: Arc<(Mutex<u64>, Condvar)> =
            Arc::new((Mutex::new(0), Condvar::new()));

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("grpc-tracker")
            .build()
            .context("failed to build tokio runtime for grpc tracker")?;

        let primary_role = if tracking_endpoint.is_some() {
            SubscriberRole::BlocksOnly
        } else {
            SubscriberRole::All
        };

        let (primary_ready_tx, primary_ready_rx) = mpsc::channel::<Result<()>>();
        spawn_subscriber(
            &runtime,
            "primary",
            primary_endpoint,
            primary_x_token,
            sender_pubkeys.clone(),
            Arc::clone(&pending),
            Arc::clone(&slot_state),
            primary_ready_tx,
            primary_role,
        );

        let tracking_ready_rx = if let Some(track_endpoint) = tracking_endpoint {
            let (tx, rx) = mpsc::channel::<Result<()>>();
            spawn_subscriber(
                &runtime,
                "tracking",
                track_endpoint,
                tracking_x_token,
                sender_pubkeys,
                Arc::clone(&pending),
                Arc::clone(&slot_state),
                tx,
                SubscriberRole::SlotsAndTransactions,
            );
            Some(rx)
        } else {
            None
        };

        primary_ready_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| anyhow!("timed out waiting for primary grpc subscriber to start"))?
            .context("primary grpc subscriber failed to start")?;
        if let Some(rx) = tracking_ready_rx {
            rx.recv_timeout(Duration::from_secs(20))
                .map_err(|_| anyhow!("timed out waiting for tracking grpc subscriber to start"))?
                .context("tracking grpc subscriber failed to start")?;
        }

        Ok(Self {
            pending,
            slot_state,
            runtime: Some(runtime),
        })
    }

    pub fn current_slot(&self) -> u64 {
        let (m, _) = &*self.slot_state;
        *m.lock().expect("slot lock poisoned")
    }

    /// Block until the tracker observes a slot strictly greater than `last_seen`,
    /// or `timeout` elapses. Returns the new slot, or `None` on timeout.
    pub fn wait_for_next_slot(&self, last_seen: u64, timeout: Duration) -> Option<u64> {
        let (m, cv) = &*self.slot_state;
        let mut guard = m.lock().expect("slot lock poisoned");
        if *guard > last_seen {
            return Some(*guard);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let remaining = deadline - now;
            let (g, result) = cv
                .wait_timeout(guard, remaining)
                .expect("slot condvar poisoned");
            guard = g;
            if *guard > last_seen {
                return Some(*guard);
            }
            if result.timed_out() {
                return None;
            }
        }
    }

    pub fn register(
        &self,
        signature: String,
        submit_started: Instant,
        submit_wall: SystemTime,
    ) -> PendingHandle {
        let (tx, rx) = mpsc::channel();
        let entry = PendingEntry {
            submit_started,
            submit_wall,
            sender: tx,
        };
        self.pending
            .lock()
            .expect("pending lock poisoned")
            .insert(signature.clone(), entry);
        PendingHandle {
            pending: Arc::clone(&self.pending),
            signature,
            receiver: rx,
        }
    }
}

impl Drop for GrpcTracker {
    fn drop(&mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

fn spawn_subscriber(
    runtime: &Runtime,
    label: &'static str,
    endpoint: String,
    x_token: Option<String>,
    sender_pubkeys: Vec<String>,
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    slot_state: Arc<(Mutex<u64>, Condvar)>,
    ready_tx: mpsc::Sender<Result<()>>,
    role: SubscriberRole,
) {
    runtime.spawn(async move {
        if let Err(e) = run_subscriber(
            endpoint,
            x_token,
            sender_pubkeys,
            pending,
            slot_state,
            ready_tx,
            role,
        )
        .await
        {
            eprintln!("[grpc-tracker:{}] subscriber exited: {:#}", label, e);
        }
    });
}

async fn run_subscriber(
    endpoint: String,
    x_token: Option<String>,
    sender_pubkeys: Vec<String>,
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    slot_state: Arc<(Mutex<u64>, Condvar)>,
    ready_tx: mpsc::Sender<Result<()>>,
    role: SubscriberRole,
) -> Result<()> {
    let connect = async {
        let mut builder =
            GeyserGrpcClient::build_from_shared(endpoint).context("invalid grpc endpoint")?;
        if let Some(token) = x_token {
            builder = builder.x_token(Some(token)).context("invalid x_token")?;
        }
        let client = builder
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .context("invalid tls config")?
            .connect()
            .await
            .context("failed to connect to grpc endpoint")?;
        Ok::<_, anyhow::Error>(client)
    };

    let mut client = match connect.await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("{:#}", e)));
            return Err(e);
        }
    };

    let want_transactions = matches!(
        role,
        SubscriberRole::All | SubscriberRole::SlotsAndTransactions
    );
    let want_blocks = matches!(role, SubscriberRole::All | SubscriberRole::BlocksOnly);
    let want_slots = matches!(
        role,
        SubscriberRole::All | SubscriberRole::SlotsAndTransactions
    );

    let mut transactions_filter = HashMap::new();
    if want_transactions {
        transactions_filter.insert(
            "tx".to_string(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: None,
                signature: None,
                account_include: sender_pubkeys.clone(),
                account_exclude: vec![],
                account_required: vec![],
            },
        );
    }

    let mut blocks_filter = HashMap::new();
    if want_blocks {
        blocks_filter.insert(
            "block".to_string(),
            SubscribeRequestFilterBlocks {
                account_include: sender_pubkeys.clone(),
                include_transactions: Some(true),
                include_accounts: Some(false),
                include_entries: Some(false),
            },
        );
    }

    let mut slots_filter = HashMap::new();
    if want_slots {
        slots_filter.insert(
            "slots".to_string(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(true),
                interslot_updates: Some(false),
            },
        );
    }

    let request = SubscribeRequest {
        slots: slots_filter,
        transactions: transactions_filter,
        blocks: blocks_filter,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };

    let (mut subscribe_tx, mut stream) = match client.subscribe_with_request(Some(request)).await {
        Ok(pair) => pair,
        Err(e) => {
            let err = anyhow!("subscribe_with_request failed: {}", e);
            let _ = ready_tx.send(Err(anyhow!("{:#}", err)));
            return Err(err);
        }
    };

    // Subscribers without a slots filter never receive slot updates, so we can't
    // gate readiness on the first slot tick — signal immediately after subscribe.
    let mut ready_signaled = if !want_slots {
        let _ = ready_tx.send(Ok(()));
        true
    } else {
        false
    };

    while let Some(message) = stream.next().await {
        let update = match message {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[grpc-tracker] stream error: {}", e);
                continue;
            }
        };

        let now = Instant::now();
        let created_at = update.created_at.clone();

        match update.update_oneof {
            Some(UpdateOneof::Slot(slot_update)) => {
                if slot_update.status == CommitmentLevel::Processed as i32 {
                    let (m, cv) = &*slot_state;
                    {
                        let mut guard = m.lock().expect("slot lock poisoned");
                        if slot_update.slot > *guard {
                            *guard = slot_update.slot;
                            cv.notify_all();
                        }
                    }
                    if !ready_signaled {
                        let _ = ready_tx.send(Ok(()));
                        ready_signaled = true;
                    }
                }
            }
            Some(UpdateOneof::Transaction(tx_update)) => {
                let slot = tx_update.slot;
                if let Some(tx_info) = tx_update.transaction {
                    let sig_str = match signature_from_bytes(&tx_info.signature) {
                        Some(s) => s,
                        None => continue,
                    };
                    let entry = match pending.lock().unwrap().get(&sig_str) {
                        Some(e) => Some((e.submit_started, e.submit_wall, e.sender.clone())),
                        None => None,
                    };
                    if let Some((started, wall, sender)) = entry {
                        let local_ms = duration_ms(now.duration_since(started));
                        let grpc_ms = grpc_relative_ms(wall, &created_at);
                        let err = tx_info
                            .meta
                            .as_ref()
                            .and_then(|m| m.err.as_ref())
                            .map(|e| format!("{:?}", e));
                        let _ = sender.send(LandingEvent::Transaction {
                            slot,
                            local_received_ms: local_ms,
                            grpc_created_at_ms: grpc_ms,
                            err,
                        });
                    }
                }
            }
            Some(UpdateOneof::Block(block_update)) => {
                let block_slot = block_update.slot;

                let pending_set: HashSet<String> = {
                    let guard = pending.lock().unwrap();
                    if guard.is_empty() {
                        continue;
                    }
                    guard.keys().cloned().collect()
                };

                for (idx, tx) in block_update.transactions.iter().enumerate() {
                    let sig_str = match signature_from_bytes(&tx.signature) {
                        Some(s) => s,
                        None => continue,
                    };
                    if !pending_set.contains(&sig_str) {
                        continue;
                    }
                    let entry = match pending.lock().unwrap().get(&sig_str) {
                        Some(e) => Some((e.submit_started, e.submit_wall, e.sender.clone())),
                        None => None,
                    };
                    if let Some((started, wall, sender)) = entry {
                        let local_ms = duration_ms(now.duration_since(started));
                        let grpc_ms = grpc_relative_ms(wall, &created_at);
                        let _ = sender.send(LandingEvent::Block {
                            slot: block_slot,
                            index_in_block: idx,
                            local_received_ms: local_ms,
                            grpc_created_at_ms: grpc_ms,
                        });
                    }
                }
            }
            Some(UpdateOneof::Ping(_)) => {
                let _ = subscribe_tx
                    .send(SubscribeRequest {
                        ping: Some(SubscribeRequestPing { id: 1 }),
                        ..Default::default()
                    })
                    .await;
            }
            _ => {}
        }
    }

    Ok(())
}

fn signature_from_bytes(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 64 {
        return None;
    }
    Signature::try_from(bytes).ok().map(|s| s.to_string())
}

fn duration_ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn grpc_relative_ms(
    submit_wall: SystemTime,
    created_at: &Option<yellowstone_grpc_proto::prost_types::Timestamp>,
) -> Option<f64> {
    let ts = created_at.as_ref()?;
    let created_unix_ms = (ts.seconds as f64) * 1000.0 + (ts.nanos as f64) / 1_000_000.0;
    let submit_unix = submit_wall.duration_since(UNIX_EPOCH).ok()?;
    let submit_unix_ms = submit_unix.as_secs_f64() * 1000.0;
    Some(created_unix_ms - submit_unix_ms)
}
