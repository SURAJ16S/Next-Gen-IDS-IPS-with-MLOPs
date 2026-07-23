package main

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -type packet_event -cflags "-O2 -g -I/usr/include/x86_64-linux-gnu" bpf ebpf/monitor.c
