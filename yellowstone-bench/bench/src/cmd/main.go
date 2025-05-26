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

type BenchmarkStats struct {
	matchCount  int
	file0Faster int
	file1Faster int
	totalDiff   time.Duration
}

type TransactionData map[string]time.Time

type StringSlice []string

func (s *StringSlice) String() string { return fmt.Sprintf("%v", *s) }
func (s *StringSlice) Set(val string) error {
	*s = append(*s, val)
	return nil
}

var subscribeRequest = geyserpb.SubscribeRequest{
	Transactions: map[string]*geyserpb.SubscribeRequestFilterTransactions{
		"alltxs": {
			AccountInclude: []string{"6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}, // pump.fun
		},
	},
}

func subscribe(ctx context.Context, url string, token *string, file *os.File, wg *sync.WaitGroup) error {
	hostname := strings.Split(url, ":")[0]
	port := strings.Split(url, ":")[1]

	ips, err := net.DefaultResolver.LookupIP(context.Background(), "ip4", hostname)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("no IPv4 address found for %s: %+v", url, err)
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
		return fmt.Errorf("failed to connect to %s: %v", url, err)
	}
	defer conn.Close()

	client := geyserpb.NewGeyserClient(conn)

	md := metadata.New(map[string]string{"x-token": *token})
	ctx = metadata.NewOutgoingContext(ctx, md)

	stream, err := client.Subscribe(ctx)
	if err != nil {
		return fmt.Errorf("failed to subscribe to %s: %v", url, err)
	}

	log.Printf("subscribed for transactions to %s", url)

	err = stream.Send(&subscribeRequest)
	if err != nil {
		return fmt.Errorf("failed to make subscription request to %s: %v", url, err)
	}

	// Create a channel for receiving messages
	msgChan := make(chan *geyserpb.SubscribeUpdate, 100) // Buffer size of 100 to prevent blocking
	errc := make(chan error)

	// Start a goroutine to receive messages
	go func() {
		for {
			msg, err := stream.Recv()
			if err != nil {
				if err == context.DeadlineExceeded {
					// exceeded benchmark duration
					return
				}
				errc <- err
			}

			select {
			case msgChan <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Process messages until context is done
	for {
		select {
		case <-ctx.Done():
			wg.Done()
			return nil
		case err := <-errc:
			wg.Done()
			return fmt.Errorf("failed to receive message from %s: %v", url, err)
		case msg, ok := <-msgChan:
			if !ok {
				wg.Done()
				return nil
			}
			timeCreated := msg.CreatedAt.AsTime().UTC().Format(time.RFC3339Nano)
			if msg.GetTransaction() != nil {
				tx := msg.GetTransaction().Transaction.GetSignature()
				if tx != nil {
					_, err := fmt.Fprintf(file, "%s %s\n", timeCreated, base58.Encode(tx))
					if err != nil {
						wg.Done()
						return fmt.Errorf("failed to write to file: %v", err)
					}
				}
			}
		}
	}
}

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

func printBenchmarkResults(stats BenchmarkStats, url1 string, url2 string) error {
	if stats.matchCount == 0 {
		return fmt.Errorf("no matching transactions found")
	}

	log.Printf("Found %d matching transactions", stats.matchCount)

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

	return nil
}

func bench(url1 string, url2 string, files []*os.File) error {
	txsMap := make(map[string]TransactionData)

	for _, file := range files {
		content, err := os.ReadFile(file.Name())
		if err != nil {
			return fmt.Errorf("failed to read %s: %v", file.Name(), err)
		}

		txs, err := parseTransactionFile(string(content))
		if err != nil {
			return fmt.Errorf("failed to parse %s: %v", file.Name(), err)
		}

		txsMap[file.Name()] = txs
	}

	stats := calculateStats(txsMap[files[0].Name()], txsMap[files[1].Name()])
	err := printBenchmarkResults(stats, url1, url2)
	if err != nil {
		return err
	}

	return nil
}

func main() {
	var url1, token1, url2, token2 string
	var filesArg StringSlice
	var files []*os.File
	var benchDuration time.Duration

	flag.StringVar(&url1, "url1", "", "URL of the first geyser node")
	flag.StringVar(&token1, "token1", "", "Token of the first geyser node")
	flag.StringVar(&url2, "url2", "", "URL of the second geyser node")
	flag.StringVar(&token2, "token2", "", "Token of the second geyser node")
	flag.DurationVar(&benchDuration, "duration", 5*time.Minute, "Duration of the benchmark")
	flag.Var(&filesArg, "file", "Files to write the geyser node's transactions to (specify 2 files)")

	flag.Parse()

	for _, file := range filesArg {
		file, err := os.Create(file)
		files = append(files, file)
		if err != nil {
			log.Printf("failed to create file %s: %v", file.Name(), err)
			return
		}
	}

	defer func() {
		for _, file := range files {
			file.Close()
			os.Remove(file.Name())
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), benchDuration)
	defer cancel()

	errsCh := make(chan error, 2)
	done := make(chan struct{})

	wg := &sync.WaitGroup{}

	wg.Add(1)
	go func() {
		errsCh <- subscribe(ctx, url1, &token1, files[0], wg)
	}()

	wg.Add(1)
	go func() {
		errsCh <- subscribe(ctx, url2, &token2, files[1], wg)
	}()

	go func() {
		for err := range errsCh {
			if err != nil {
				log.Printf("subscribe failed: %v", err)
				close(done)
				return
			}
		}
	}()

	// wait for all subscriptions to finish or error
	select {
	case <-done:
		return
	case <-ctx.Done():
		// wait for all subscriptions to finish
		wg.Wait()
	}

	err := bench(url1, url2, files)
	if err != nil {
		log.Printf("bench failed: %v", err)
		return
	}
}
