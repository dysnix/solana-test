use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use solana_client::client_error::reqwest as solana_reqwest;
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::http_sender::HttpSender;
use solana_rpc_client::rpc_client::{RpcClient, RpcClientConfig};

pub type HttpHeaderConfig = BTreeMap<String, String>;

pub fn merge_http_headers(
    global: &HttpHeaderConfig,
    provider: &HttpHeaderConfig,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    insert_http_headers(&mut headers, global)?;
    insert_http_headers(&mut headers, provider)?;
    Ok(headers)
}

fn insert_http_headers(headers: &mut HeaderMap, configured: &HttpHeaderConfig) -> Result<()> {
    for (name, value) in configured {
        let parsed_name = HeaderName::from_bytes(name.as_bytes())
            .with_context(|| format!("invalid HTTP header name '{name}'"))?;
        let mut parsed_value = HeaderValue::from_str(value)
            .with_context(|| format!("invalid value for HTTP header '{name}'"))?;
        parsed_value.set_sensitive(true);
        headers.insert(parsed_name, parsed_value);
    }
    Ok(())
}

pub fn new_rpc_client(url: String, extra_headers: &HeaderMap) -> Result<RpcClient> {
    let mut headers = HttpSender::default_headers();
    headers.extend(extra_headers.clone());
    let client = solana_reqwest::Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .context("failed to build Solana RPC HTTP client")?;
    let sender = HttpSender::new_with_client(url, client);
    Ok(RpcClient::new_sender(
        sender,
        RpcClientConfig::with_commitment(CommitmentConfig::processed()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn provider_headers_extend_and_override_global_headers() {
        let global = BTreeMap::from([
            ("Authorization".to_string(), "Bearer global".to_string()),
            ("x-common".to_string(), "global".to_string()),
        ]);
        let provider = BTreeMap::from([
            ("authorization".to_string(), "Bearer provider".to_string()),
            ("x-provider".to_string(), "provider".to_string()),
        ]);

        let headers = merge_http_headers(&global, &provider).expect("valid headers");

        assert_eq!(headers.len(), 3);
        assert_eq!(headers["authorization"], "Bearer provider");
        assert_eq!(headers["x-common"], "global");
        assert_eq!(headers["x-provider"], "provider");
        assert!(headers["authorization"].is_sensitive());
    }

    #[test]
    fn invalid_header_name_is_rejected() {
        let configured = BTreeMap::from([("bad header".to_string(), "value".to_string())]);

        let error = merge_http_headers(&configured, &BTreeMap::new())
            .expect_err("invalid header name must fail");

        assert!(
            error
                .to_string()
                .contains("invalid HTTP header name 'bad header'")
        );
    }

    #[test]
    fn invalid_header_value_is_rejected_without_echoing_the_value() {
        let configured =
            BTreeMap::from([("authorization".to_string(), "secret\nvalue".to_string())]);

        let error = merge_http_headers(&configured, &BTreeMap::new())
            .expect_err("invalid header value must fail");
        let message = error.to_string();

        assert!(message.contains("invalid value for HTTP header 'authorization'"));
        assert!(!message.contains("secret"));
    }

    #[test]
    fn rpc_client_sends_configured_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept RPC request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).expect("read RPC request");
                assert_ne!(read, 0, "connection closed before request headers");
                request.extend_from_slice(&buffer[..read]);
            }
            let response =
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 38\r\nConnection: close\r\n\r\n{\"jsonrpc\":\"2.0\",\"result\":\"ok\",\"id\":0}";
            stream.write_all(response).expect("write RPC response");
            String::from_utf8(request).expect("HTTP request is UTF-8")
        });
        let configured = BTreeMap::from([("x-test-header".to_string(), "expected".to_string())]);
        let headers = merge_http_headers(&configured, &BTreeMap::new()).expect("valid headers");
        let client = new_rpc_client(format!("http://{address}"), &headers).expect("RPC client");

        client.get_health().expect("getHealth response");
        let request = server.join().expect("test server thread");

        assert!(
            request
                .lines()
                .any(|line| line.eq_ignore_ascii_case("x-test-header: expected"))
        );
    }
}
