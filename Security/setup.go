package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"

	"ngfw-monitor/proxy"
)

const keyFile = "node.key"

type NodeConfig struct {
	NodeID        string `json:"nodeId"`
	NodeSecretKey string `json:"nodeSecretKey"`
	DashboardURL  string `json:"dashboardUrl"`
}

func getOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

func getMachineKey() []byte {
	data, err := ioutil.ReadFile("/etc/machine-id")
	if err != nil {
		data = []byte("ngfw-default-machine-key-12345")
	}
	hash := sha256.Sum256(bytes.TrimSpace(data))
	return hash[:]
}

func encrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(getMachineKey())
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, data, nil), nil
}

func decrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(getMachineKey())
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

func SaveNodeConfig(cfg NodeConfig) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	encrypted, err := encrypt(data)
	if err != nil {
		return err
	}
	err = ioutil.WriteFile(keyFile, encrypted, 0600)
	if err != nil {
		return err
	}
	return nil
}

func LoadNodeConfig() (*NodeConfig, error) {
	encrypted, err := ioutil.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}
	data, err := decrypt(encrypted)
	if err != nil {
		return nil, err
	}
	var cfg NodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func RunSetupWizard() {
	fmt.Println(bannerStyle.Render("  NGFW Agent Setup Wizard  "))
	fmt.Println()

	if _, err := LoadNodeConfig(); err == nil {
		fmt.Println("  " + ingressStyle.Render("✓") + " Node is already paired. Run without --setup to start monitoring.")
		return
	}

	pCfg, err := proxy.LoadConfig("proxy_config.yaml")
	if err != nil {
		pCfg = proxy.DefaultConfig()
	}
	dashboardURL := pCfg.CentralDashboard

	fmt.Println("  " + dimStyle.Render(fmt.Sprintf("Connecting to Central Dashboard at: %s", dashboardURL)))
	fmt.Println()

	fmt.Print("  Enter the Enrollment Secret generated from the Dashboard:\n  > ")
	var enrollmentToken string
	fmt.Scanln(&enrollmentToken)
	enrollmentToken = strings.TrimSpace(enrollmentToken)

	if enrollmentToken == "" {
		fmt.Println("\n  " + egressStyle.Render("✗") + " Token cannot be empty.")
		return
	}

	hostname, _ := os.Hostname()
	payload := map[string]string{
		"enrollmentToken": enrollmentToken,
		"hostname":        hostname,
		"ipAddress":       getOutboundIP(),
		"osVersion":       runtime.GOOS + " " + runtime.GOARCH,
	}
	jsonData, _ := json.Marshal(payload)

	resp, err := http.Post(fmt.Sprintf("%s/api/nodes/enroll", dashboardURL), "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		fmt.Printf("\n  "+egressStyle.Render("✗")+" Connection failed: %v\n", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		fmt.Println("\n  " + egressStyle.Render("✗") + " Invalid or expired Enrollment Secret.")
		return
	}

	if resp.StatusCode != 201 {
		fmt.Printf("\n  "+egressStyle.Render("✗")+" Server returned status: %d\n", resp.StatusCode)
		return
	}

	var regResult struct {
		NodeID        string `json:"nodeId"`
		NodeSecretKey string `json:"nodeSecretKey"`
	}
	json.NewDecoder(resp.Body).Decode(&regResult)

	cfg := NodeConfig{
		NodeID:        regResult.NodeID,
		NodeSecretKey: regResult.NodeSecretKey,
		DashboardURL:  dashboardURL,
	}

	if err := SaveNodeConfig(cfg); err != nil {
		fmt.Printf("\n  "+egressStyle.Render("✗")+" Failed to save node config: %v\n", err)
		return
	}

	fmt.Println("\n  " + ingressStyle.Render("✓") + " Node Paired Successfully!")
	fmt.Println("  Credentials saved securely to encrypted configuration.")
}
