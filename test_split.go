package main

import (
	"fmt"
	"strings"
)

func main() {
	s := "GET /?search=1' OR '1'='1 HTTP/1.1"
	parts := strings.SplitN(s, " ", 3)
	fmt.Printf("method: %s\n", parts[0])
	fmt.Printf("uri: %s\n", parts[1])
	fmt.Printf("ver: %s\n", parts[2])
}
