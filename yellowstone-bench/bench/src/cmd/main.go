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
	"time"

	geyserpb "github.com/dysnix/yellowstone-bench/proto"
	"github.com/mr-tron/base58"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

func bench(ctx context.Context, url string, token *string, file *os.File) {
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

	err = stream.Send(&subscription)
	if err != nil {
		log.Fatalf("failed to send subscription to %s: %v", url, err)
	}

	for {
		select {
		case <-ctx.Done():
			fmt.Println("Goroutine timed out or cancelled")
			return
		default:
			msg, err := stream.Recv()
			if err != nil {
				log.Fatalf("failed to receive message: %v", err)
			}
			timeCreated := msg.CreatedAt.AsTime().UTC().Format(time.RFC3339Nano)
			if msg.GetTransaction() != nil {
				if len(msg.GetTransaction().Transaction.Transaction.GetSignatures()) > 0 {
					_, err := fmt.Fprintf(file, "%s %s\n", timeCreated, base58.Encode(msg.GetTransaction().Transaction.Transaction.Signatures[0]))
					if err != nil {
						log.Fatalf("failed to write to file: %v", err)
					}
				}
			}
		}
	}
}

func main() {
	var url1, token1, url2, token2 string
	var duration time.Duration

	flag.StringVar(&url1, "url1", "", "URL of the first geyser node")
	flag.StringVar(&token1, "token1", "", "Token of the first geyser node")
	flag.StringVar(&url2, "url2", "", "URL of the second geyser node")
	flag.StringVar(&token2, "token2", "", "Token of the second geyser node")
	flag.DurationVar(&duration, "duration", 5*time.Minute, "Duration of the benchmark")
	flag.Parse()

	file1, _ := os.Create("txs_0.txt")
	file2, _ := os.Create("txs_1.txt")
	defer file1.Close()
	defer file2.Close()

	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()

	go bench(ctx, url1, &token1, file1)
	go bench(ctx, url2, &token2, file2)
	select {}
}
