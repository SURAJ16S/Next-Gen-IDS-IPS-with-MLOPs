package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func RunStreamer() {
	cfg, err := LoadNodeConfig()
	if err != nil {
		fmt.Println("  " + dimStyle.Render("Streamer: Could not load node config. Log streaming disabled."))
		return
	}

	logsDir := "logs"
	go tailAndSend(filepath.Join(logsDir, "detections.jsonl"), cfg, "/api/agent/telemetry/detections", "detections")
	go tailAndSend(filepath.Join(logsDir, "connections.jsonl"), cfg, "/api/agent/telemetry/connections", "connections")
	
	fmt.Println("  " + ingressStyle.Render("✓") + " Telemetry streamer running in background.")
}

func tailAndSend(filePath string, cfg *NodeConfig, endpoint string, payloadKey string) {
	for {
		file, err := os.Open(filePath)
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}

		// Seek to the end
		file.Seek(0, io.SeekEnd)
		reader := bufio.NewReader(file)

		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				if err == io.EOF {
					time.Sleep(1 * time.Second)
					continue
				}
				break
			}

			line = bytes.TrimSpace(line)
			if len(line) == 0 {
				continue
			}

			var rawJSON map[string]interface{}
			if err := json.Unmarshal(line, &rawJSON); err != nil {
				continue
			}

			payload := map[string]interface{}{
				payloadKey: []interface{}{rawJSON},
			}
			payloadBytes, _ := json.Marshal(payload)

			req, _ := http.NewRequest("POST", cfg.DashboardURL+endpoint, bytes.NewBuffer(payloadBytes))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Node-Id", cfg.NodeID)
			req.Header.Set("X-Node-Secret", cfg.NodeSecretKey)

			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				time.Sleep(2 * time.Second)
				continue
			}

			if resp.StatusCode == 401 {
				resp.Body.Close()
				file.Close()
				return 
			}
			resp.Body.Close()
		}
		file.Close()
	}
}
