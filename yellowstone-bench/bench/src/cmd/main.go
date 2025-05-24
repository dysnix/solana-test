package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	geyserpb "github.com/dysnix/yellowstone-bench/proto"
	"github.com/mr-tron/base58"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

func subscribe(ctx context.Context, url string, token *string, file *os.File, wg *sync.WaitGroup) {
	hostname := strings.Split(url, ":")[0]
	port := strings.Split(url, ":")[1]

	ips, err := net.DefaultResolver.LookupIP(context.Background(), "ip4", hostname)
	if err != nil || len(ips) == 0 {
		log.Fatalf("no IPv4 address found for %s: %+v", url, err)
	}
	ipAddr := ips[0].String()

	var creds credentials.TransportCredentials

	if strings.Contains(url, "localhost") {
		creds = insecure.NewCredentials()
	} else {
		creds = credentials.NewTLS(&tls.Config{
			ServerName:         hostname, // this ensures the correct SNI
			InsecureSkipVerify: true,
		})
	}

	conn, err := grpc.NewClient(
		fmt.Sprintf("%s:%s", ipAddr, port),
		grpc.WithTransportCredentials(creds),
	)
	if err != nil {
		log.Fatalf("failed to connect to %s: %v", url, err)
	}
	defer conn.Close()

	client := geyserpb.NewGeyserClient(conn)

	subscription := geyserpb.SubscribeRequest{}

	subscription.Transactions = make(map[string]*geyserpb.SubscribeRequestFilterTransactions)
	subscription.Transactions["alltxs"] = &geyserpb.SubscribeRequestFilterTransactions{
		AccountInclude: []string{"6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"},
	}

	md := metadata.New(map[string]string{"x-token": *token})
	ctx = metadata.NewOutgoingContext(ctx, md)

	stream, err := client.Subscribe(ctx)
	if err != nil {
		log.Fatalf("failed to subscribe to %s: %v", url, err)
	}

	log.Printf("subscribed for transactions to %s", url)

	err = stream.Send(&subscription)
	if err != nil {
		log.Fatalf("failed to send subscription to %s: %v", url, err)
	}

	// Create a channel for receiving messages
	msgChan := make(chan *geyserpb.SubscribeUpdate, 100) // Buffer size of 100 to prevent blocking

	// Start a goroutine to receive messages
	go func() {
		defer close(msgChan)
		for {
			select {
			case <-ctx.Done():
				return
			default:
				msg, err := stream.Recv()
				if err != nil {
					if ctx.Err() == context.DeadlineExceeded {
						// exceeded benchmark duration
						return
					}
					log.Printf("failed to receive message: %v", err)
					return
				}
				select {
				case msgChan <- msg:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	// Process messages until context is done
	for {
		select {
		case <-ctx.Done():
			wg.Done()
			return
		case msg, ok := <-msgChan:
			if !ok {
				wg.Done()
				return
			}
			timeCreated := msg.CreatedAt.AsTime().UTC().Format(time.RFC3339Nano)
			if msg.GetTransaction() != nil {
				if len(msg.GetTransaction().Transaction.Transaction.GetSignatures()) > 0 {
					_, err := fmt.Fprintf(file, "%s %s\n", timeCreated, base58.Encode(msg.GetTransaction().Transaction.Transaction.Signatures[0]))
					if err != nil {
						log.Printf("failed to write to file: %v", err)
						wg.Done()
						return
					}
				}
			}
		}
	}
}

type BenchmarkStats struct {
	matchCount  int
	file0Faster int
	file1Faster int
	totalDiff   time.Duration
}

type TransactionData map[string]time.Time

func parseTransactionFile(content string) (TransactionData, error) {
	transactions := make(TransactionData)

	for line := range strings.SplitSeq(content, "\n") {
		if line == "" {
			continue
		}

		parts := strings.Split(line, " ")
		if len(parts) != 2 {
			continue
		}

		timestamp, err := time.Parse(time.RFC3339Nano, parts[0])
		if err != nil {
			return nil, fmt.Errorf("error parsing timestamp: %v", err)
		}

		transactions[parts[1]] = timestamp
	}

	return transactions, nil
}

func calculateStats(txs0 TransactionData, txs1 TransactionData) BenchmarkStats {
	var stats BenchmarkStats

	for txHash, t1 := range txs0 {
		if t2, exists := txs1[txHash]; exists {
			stats.matchCount++
			diff := t1.Sub(t2)

			if diff < 0 {
				stats.file0Faster++
			} else if diff > 0 {
				stats.file1Faster++
			}
			stats.totalDiff += diff
		}
	}

	return stats
}

func printBenchmarkResults(stats BenchmarkStats, url1 string, url2 string) {
	if stats.matchCount == 0 {
		log.Printf("No matching transactions found")
		return
	}

	log.Printf("Found %d matching transactions across %s and %s", stats.matchCount, url1, url2)

	// Calculate percentages
	file0Percentage := float64(stats.file0Faster) / float64(stats.matchCount) * 100
	file1Percentage := float64(stats.file1Faster) / float64(stats.matchCount) * 100

	log.Printf("%s was faster in %d cases (%.2f%%)",
		url1, stats.file0Faster, file0Percentage)
	log.Printf("%s was faster in %d cases (%.2f%%)",
		url2, stats.file1Faster, file1Percentage)

	// Calculate and display average time difference
	avgDiff := stats.totalDiff / time.Duration(stats.matchCount)
	if avgDiff < 0 {
		log.Printf("%s is ahead of %s by %v", url1, url2, -avgDiff)
	} else if avgDiff > 0 {
		log.Printf("%s is ahead of %s by %v", url2, url1, avgDiff)
	} else {
		log.Printf("both endpoints perform equally")
	}
}

func bench(url1 string, url2 string) {

	// Read results
	file0, err := os.ReadFile("txs_0.txt")
	if err != nil {
		log.Fatalf("failed to read txs_0.txt: %v", err)
	}

	file1, err := os.ReadFile("txs_1.txt")
	if err != nil {
		log.Fatalf("failed to read txs_1.txt: %v", err)
	}

	// Parse results
	txs0, err := parseTransactionFile(string(file0))
	if err != nil {
		log.Fatalf("failed to parse txs_0.txt: %v", err)
	}

	txs1, err := parseTransactionFile(string(file1))
	if err != nil {
		log.Fatalf("failed to parse txs_1.txt: %v", err)
	}

	// Calculate differences
	stats := calculateStats(txs0, txs1)

	// Print final results
	printBenchmarkResults(stats, url1, url2)
}

func main() {
	var url1, token1, url2, token2 string
	var duration time.Duration
	wg := &sync.WaitGroup{}

	flag.StringVar(&url1, "url1", "", "URL of the first geyser node")
	flag.StringVar(&token1, "token1", "", "Token of the first geyser node")
	flag.StringVar(&url2, "url2", "", "URL of the second geyser node")
	flag.StringVar(&token2, "token2", "", "Token of the second geyser node")
	flag.DurationVar(&duration, "duration", 5*time.Minute, "Duration of the benchmark")
	flag.Parse()

	file1, _ := os.Create("txs_0.txt")
	file2, _ := os.Create("txs_1.txt")

	defer func() {
		file1.Close()
		file2.Close()
		os.Remove(file1.Name())
		os.Remove(file2.Name())
	}()

	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()

	wg.Add(1)
	go subscribe(ctx, url1, &token1, file1, wg)
	wg.Add(1)
	go subscribe(ctx, url2, &token2, file2, wg)

	wg.Wait()

	bench(url1, url2)
}
