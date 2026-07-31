package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type CommandMsg struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

func RunCommander() {
	cfg, err := LoadNodeConfig()
	if err != nil {
		fmt.Println("  " + dimStyle.Render("Commander: Could not load node config. Real-time control disabled."))
		return
	}

	wsURL := strings.Replace(cfg.DashboardURL, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)

	header := http.Header{}
	header.Add("X-Node-Id", cfg.NodeID)
	header.Add("X-Node-Secret", cfg.NodeSecretKey)

	go func() {
		for {
			conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
			if err != nil {
				time.Sleep(5 * time.Second)
				continue
			}

			fmt.Println("\n  " + ingressStyle.Render("✓") + " Connected to real-time control plane.")

			for {
				_, message, err := conn.ReadMessage()
				if err != nil {
					conn.Close()
					break
				}

				var cmd CommandMsg
				if err := json.Unmarshal(message, &cmd); err != nil {
					continue
				}

				handleCommand(cmd)
			}

			time.Sleep(5 * time.Second)
		}
	}()
}

func handleCommand(cmd CommandMsg) {
	log.Printf("Received command from dashboard: %s -> %s", cmd.Type, cmd.Value)
	
	switch cmd.Type {
	case "block_ip":
		fmt.Printf("\n  [ACTION] Central Dashboard commanded IP Block: %s\n", cmd.Value)
	case "unblock_ip":
		fmt.Printf("\n  [ACTION] Central Dashboard commanded IP Unblock: %s\n", cmd.Value)
	case "update_rules":
		fmt.Printf("\n  [ACTION] Central Dashboard commanded Rule Update\n")
	}
}
