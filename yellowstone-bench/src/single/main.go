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

type TransactionData map[string]time.Time

type StringSlice []string

func (s *StringSlice) String() string { return fmt.Sprintf("%v", *s) }
func (s *StringSlice) Set(val string) error {
	*s = append(*s, val)
	return nil
}

var subscribeRequest = geyserpb.SubscribeRequest{
	Transactions: map[string]*geyserpb.SubscribeRequestFilterTransactions{
		"alltxs": {},
	},
}

func subscribe(ctx context.Context, url string, token string, file *os.File) error {
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

	md := metadata.New(map[string]string{"x-token": token})
	ctx = metadata.NewOutgoingContext(ctx, md)

	stream, err := client.Subscribe(ctx)
	if err != nil {
		return fmt.Errorf("failed to subscribe to %s: %v", url, err)
	}

	log.Printf("subscribed to %s: %s", url, subscribeRequest.String())

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
			return nil
		case err := <-errc:
			return fmt.Errorf("failed to receive message from %s: %v", url, err)
		case msg, ok := <-msgChan:
			if !ok {
				return nil
			}
			if msg.GetTransaction() != nil {
				tx := msg.GetTransaction().Transaction.GetSignature()
				if tx != nil {
					ts := time.Now().UTC().Format("2006-01-02T15:04:05.000000-07:00")
					_, err := fmt.Fprintf(file, "%s %s\n", ts, base58.Encode(tx))
					if err != nil {
						return fmt.Errorf("failed to write to file: %v", err)
					}
				}
			}
		}
	}
}

func main() {
	var url string
	var token string
	var save bool
	var filesArg StringSlice
	var benchDuration time.Duration

	flag.StringVar(&url, "url", "solana-yellowstone-grpc.rpcfast.net:443", "URL of the geyser node")
	flag.StringVar(&token, "token", "", "Token of the geyser node")
	flag.DurationVar(&benchDuration, "duration", 5*time.Minute, "Duration of the benchmark")
	flag.BoolVar(&save, "save", false, "Save transactions to the file")
	flag.Var(&filesArg, "file", "File to write the geyser node's transactions to")

	flag.Parse()

	if token == "" {
		log.Fatal("token is required")
	}

	if len(filesArg) == 0 {
		log.Fatal("no output file specified")
	}

	file, err := os.Create(filesArg[0])
	if err != nil {
		log.Fatalf("failed to create file %s: %v", filesArg[0], err)
	}
	defer file.Close()

	ctx, cancel := context.WithTimeout(context.Background(), benchDuration)
	defer cancel()

	err = subscribe(ctx, url, token, file)
	if err != nil {
		log.Printf("subscribe failed: %v", err)
		return
	}
}
