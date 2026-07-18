// SPDX-License-Identifier: GPL-2.0
// monitor.c — eBPF kernel program for bidirectional TCP/UDP traffic monitoring.
// Attaches to TC ingress/egress hooks, filters packets by a user-specified port,
// and pushes matched packet metadata to userspace via a ring buffer.

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <linux/in.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// ──────────────────────────────────────────────────────────────────────────────
// Data structures
// ──────────────────────────────────────────────────────────────────────────────

// Packet event pushed to userspace via ring buffer
struct packet_event {
    // ── IP Layer ──
    __u32 src_ip;
    __u32 dest_ip;
    __u16 pkt_size;     // Total IP packet size (ip.tot_len)
    __u8  protocol;     // IPPROTO_TCP (6) or IPPROTO_UDP (17)
    __u8  ttl;          // Time To Live
    __u8  tos;          // Type of Service / DSCP + ECN
    __u8  ip_hdr_len;   // IP header length in bytes
    __u16 ip_id;        // IP identification field
    __u16 ip_frag_off;  // Fragment offset + flags

    // ── L4 (TCP/UDP) ──
    __u16 src_port;
    __u16 dest_port;

    // TCP-specific (zeroed for UDP)
    __u32 tcp_seq;      // TCP sequence number
    __u32 tcp_ack;      // TCP acknowledgment number
    __u8  tcp_flags;    // TCP flags bitmask (FIN=0x01, SYN=0x02, RST=0x04,
                        //   PSH=0x08, ACK=0x10, URG=0x20)
    __u8  tcp_hdr_len;  // TCP header length in bytes (data offset * 4)
    __u16 tcp_window;   // TCP window size

    // ── Metadata ──
    __u8  direction;    // 0 = Ingress (incoming), 1 = Egress (outgoing)
    __u8  pad[3];       // Padding for alignment
    __u64 timestamp;    // Kernel timestamp (nanoseconds)
};

// ──────────────────────────────────────────────────────────────────────────────
// BPF Maps
// ──────────────────────────────────────────────────────────────────────────────

// Config map: userspace writes the target port here (key=0, value=port)
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u16);
    __uint(max_entries, 1);
} port_config SEC(".maps");

// Ring buffer: kernel pushes packet_event structs to userspace
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24); // 16 MB
} packet_events SEC(".maps");

// ──────────────────────────────────────────────────────────────────────────────
// Packet processing logic
// ──────────────────────────────────────────────────────────────────────────────

static __always_inline int process_packet(struct __sk_buff *skb, __u8 direction) {
    // 1. Read the target port from the config map
    __u32 key = 0;
    __u16 *target_port = bpf_map_lookup_elem(&port_config, &key);
    if (!target_port)
        return TC_ACT_OK; // No port configured, pass all traffic

    // 2. Parse Ethernet header
    struct ethhdr eth;
    if (bpf_skb_load_bytes(skb, 0, &eth, sizeof(eth)) < 0)
        return TC_ACT_OK;

    // Only process IPv4 packets
    if (eth.h_proto != bpf_htons(ETH_P_IP))
        return TC_ACT_OK;

    // 3. Parse IP header
    struct iphdr ip;
    if (bpf_skb_load_bytes(skb, sizeof(struct ethhdr), &ip, sizeof(ip)) < 0)
        return TC_ACT_OK;

    __u16 src_port = 0;
    __u16 dest_port = 0;
    __u8 protocol = ip.protocol;

    // Calculate IP header length (IHL field × 4 bytes)
    __u32 ip_hdr_len = ip.ihl * 4;
    if (ip_hdr_len < 20 || ip_hdr_len > 60)
        return TC_ACT_OK;

    __u32 l4_offset = sizeof(struct ethhdr) + ip_hdr_len;

    // TCP-specific fields (default zero for UDP)
    __u32 tcp_seq = 0;
    __u32 tcp_ack = 0;
    __u8  tcp_flags = 0;
    __u8  tcp_hdr_len = 0;
    __u16 tcp_window = 0;

    // 4. Parse L4 (TCP or UDP) header
    if (protocol == IPPROTO_TCP) {
        struct tcphdr tcp;
        if (bpf_skb_load_bytes(skb, l4_offset, &tcp, sizeof(tcp)) < 0)
            return TC_ACT_OK;
        src_port  = bpf_ntohs(tcp.source);
        dest_port = bpf_ntohs(tcp.dest);
        tcp_seq   = bpf_ntohl(tcp.seq);
        tcp_ack   = bpf_ntohl(tcp.ack_seq);
        tcp_hdr_len = tcp.doff * 4;
        tcp_window  = bpf_ntohs(tcp.window);

        // Build TCP flags bitmask
        if (tcp.fin) tcp_flags |= 0x01;
        if (tcp.syn) tcp_flags |= 0x02;
        if (tcp.rst) tcp_flags |= 0x04;
        if (tcp.psh) tcp_flags |= 0x08;
        if (tcp.ack) tcp_flags |= 0x10;
        if (tcp.urg) tcp_flags |= 0x20;
    } else if (protocol == IPPROTO_UDP) {
        struct udphdr udp;
        if (bpf_skb_load_bytes(skb, l4_offset, &udp, sizeof(udp)) < 0)
            return TC_ACT_OK;
        src_port  = bpf_ntohs(udp.source);
        dest_port = bpf_ntohs(udp.dest);
    } else {
        // Not TCP or UDP, skip
        return TC_ACT_OK;
    }

    // 5. Check if either source or destination port matches the target
    __u16 tp = *target_port;
    if (src_port != tp && dest_port != tp)
        return TC_ACT_OK;

    // 6. Push event to ring buffer
    struct packet_event *event;
    event = bpf_ringbuf_reserve(&packet_events, sizeof(*event), 0);
    if (!event)
        return TC_ACT_OK;

    // IP layer
    event->src_ip      = ip.saddr;
    event->dest_ip     = ip.daddr;
    event->pkt_size    = bpf_ntohs(ip.tot_len);
    event->protocol    = protocol;
    event->ttl         = ip.ttl;
    event->tos         = ip.tos;
    event->ip_hdr_len  = (__u8)ip_hdr_len;
    event->ip_id       = bpf_ntohs(ip.id);
    event->ip_frag_off = bpf_ntohs(ip.frag_off);

    // L4 layer
    event->src_port    = src_port;
    event->dest_port   = dest_port;
    event->tcp_seq     = tcp_seq;
    event->tcp_ack     = tcp_ack;
    event->tcp_flags   = tcp_flags;
    event->tcp_hdr_len = tcp_hdr_len;
    event->tcp_window  = tcp_window;

    // Metadata
    event->direction   = direction;
    event->pad[0]      = 0;
    event->pad[1]      = 0;
    event->pad[2]      = 0;
    event->timestamp   = bpf_ktime_get_ns();

    bpf_ringbuf_submit(event, 0);

    return TC_ACT_OK; // Always pass the packet (monitor only, no blocking)
}

// ──────────────────────────────────────────────────────────────────────────────
// TC hook entry points
// ──────────────────────────────────────────────────────────────────────────────

SEC("tc")
int handle_ingress(struct __sk_buff *skb) {
    return process_packet(skb, 0);
}

SEC("tc")
int handle_egress(struct __sk_buff *skb) {
    return process_packet(skb, 1);
}

char __license[] SEC("license") = "GPL";

// Force BTF emission of packet_event so bpf2go -type can find it
struct packet_event *unused_event __attribute__((unused));
