#!/bin/bash
sudo ./ngfw-monitor << 'INPUT' &
3
eth0
80
INPUT
MONITOR_PID=$!
echo "Started monitor with PID $MONITOR_PID"
sleep 5
echo "Curling 10081..."
curl -v http://localhost:10081
sleep 3
echo "Killing monitor..."
sudo kill $MONITOR_PID
