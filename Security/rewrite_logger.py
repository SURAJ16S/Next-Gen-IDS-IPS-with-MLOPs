import re

with open("detect/logger.go", "r") as f:
    content = f.read()

# 1. Add "strings" to imports
content = content.replace('"sync/atomic"\n\t"time"', '"strings"\n\t"sync/atomic"\n\t"time"')

# 2. Update JSONLLogger struct
struct_find = """type JSONLLogger struct {
	logDir          string
	detectionFile   *os.File
	connectionFile  *os.File
	mu              sync.Mutex
	maxFileSize     int64 // Max size in bytes before rotation"""

struct_replace = """type JSONLLogger struct {
	logDir           string
	detectionFile    *os.File
	connectionFile   *os.File
	protocolFiles    map[string]*os.File
	protocolBytes    map[string]int64
	sessionTimestamp string
	mu               sync.Mutex
	maxFileSize      int64 // Max size in bytes before rotation"""

content = content.replace(struct_find, struct_replace)

# 3. Update NewJSONLLogger
new_logger_find = """func NewJSONLLogger(logDir string, maxFileSizeMB int) (*JSONLLogger, error) {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	detPath := filepath.Join(logDir, "detections.jsonl")"""

new_logger_replace = """func NewJSONLLogger(logDir string, maxFileSizeMB int) (*JSONLLogger, error) {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	protocolsDir := filepath.Join(logDir, "protocols")
	if err := os.MkdirAll(protocolsDir, 0755); err != nil {
		return nil, fmt.Errorf("create protocols directory: %w", err)
	}

	detPath := filepath.Join(logDir, "detections.jsonl")"""

content = content.replace(new_logger_find, new_logger_replace)

init_find = """	l := &JSONLLogger{
		logDir:          logDir,
		detectionFile:   detFile,
		connectionFile:  connFile,
		maxFileSize:     maxSize,
		detectionBytes:  detStat.Size(),
		connectionBytes: connStat.Size(),
	}"""

init_replace = """	l := &JSONLLogger{
		logDir:           logDir,
		detectionFile:    detFile,
		connectionFile:   connFile,
		protocolFiles:    make(map[string]*os.File),
		protocolBytes:    make(map[string]int64),
		sessionTimestamp: time.Now().Format("20060102_150405"),
		maxFileSize:      maxSize,
		detectionBytes:   detStat.Size(),
		connectionBytes:  connStat.Size(),
	}"""

content = content.replace(init_find, init_replace)

# 4. Update OnDetection
on_det_find = """	l.detectionCount.Add(1)
	l.detectionBytes += int64(n)

	// Check if rotation is needed
	if l.detectionBytes >= l.maxFileSize {
		l.rotateFile("detections")
	}
}"""

on_det_replace = """	l.detectionCount.Add(1)
	l.detectionBytes += int64(n)

	// Check if rotation is needed
	if l.detectionBytes >= l.maxFileSize {
		l.rotateFile("detections")
	}

	// Protocol-specific logging
	proto := d.Protocol
	if proto == "" {
		proto = "unknown"
	}
	proto = strings.ToLower(proto)

	protoFile, exists := l.protocolFiles[proto]
	if !exists {
		fileName := fmt.Sprintf("%s_%s.jsonl", proto, l.sessionTimestamp)
		filePath := filepath.Join(l.logDir, "protocols", fileName)
		f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			log.Printf("[logger] Failed to open protocol log %s: %v", fileName, err)
			return
		}
		protoFile = f
		l.protocolFiles[proto] = protoFile
		
		stat, _ := f.Stat()
		l.protocolBytes[proto] = stat.Size()
	}

	pn, err := protoFile.Write(data)
	if err != nil {
		log.Printf("[logger] Failed to write to protocol log %s: %v", proto, err)
		return
	}

	l.protocolBytes[proto] += int64(pn)

	if l.protocolBytes[proto] >= l.maxFileSize {
		l.rotateProtocolFile(proto)
	}
}"""

content = content.replace(on_det_find, on_det_replace)

# 5. Add rotateProtocolFile
rotate_proto = """
// rotateProtocolFile rotates a protocol-specific log file.
// Must be called with l.mu held.
func (l *JSONLLogger) rotateProtocolFile(proto string) {
	oldFile := l.protocolFiles[proto]
	if oldFile != nil {
		oldFile.Close()
	}

	newTimestamp := time.Now().Format("20060102_150405")
	newFileName := fmt.Sprintf("%s_%s.jsonl", proto, newTimestamp)
	newPath := filepath.Join(l.logDir, "protocols", newFileName)

	newFile, err := os.OpenFile(newPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("[logger] Failed to create new protocol log %s: %v", newFileName, err)
		delete(l.protocolFiles, proto)
		delete(l.protocolBytes, proto)
		return
	}

	l.protocolFiles[proto] = newFile
	l.protocolBytes[proto] = 0
}
"""

content = content.replace("func (l *JSONLLogger) rotateFile(fileType string) {", rotate_proto + "\nfunc (l *JSONLLogger) rotateFile(fileType string) {")

# 6. Update Close
close_find = """	if err := l.connectionFile.Close(); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {"""

close_replace = """	if err := l.connectionFile.Close(); err != nil {
		errs = append(errs, err)
	}
	for _, f := range l.protocolFiles {
		if err := f.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {"""

content = content.replace(close_find, close_replace)

with open("detect/logger.go", "w") as f:
    f.write(content)
