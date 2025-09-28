package transport

import (
	"Chatbot-Go/internal/sttclient"
	"encoding/binary"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins
	},
}

// SttResponse defines the structure for STT JSON messages.
type SttResponse struct {
	Type   string `json:"type"` // "PARTIAL" or "FINAL"
	Text   string `json:"text"`
	TurnID string `json:"turn_id"`
}

// pcm16ToFloat32 converts a byte slice of PCM16 audio to a float32 slice.
func pcm16ToFloat32(pcmData []byte) []float32 {
	samples := len(pcmData) / 2
	floatData := make([]float32, samples)
	for i := 0; i < samples; i++ {
		sample := binary.LittleEndian.Uint16(pcmData[i*2 : (i+1)*2])
		floatData[i] = float32(int16(sample)) / 32768.0
	}
	return floatData
}

func handleSttConnection(conn *websocket.Conn) {
	recognizer, err := sttclient.NewRecognizer()
	if err != nil {
		log.Fatalf("Failed to create recognizer: %v", err)
		return
	}
	defer recognizer.Close()

	log.Println("Client connected to STT WebSocket with real STT engine")

	// Channel to signal that the client has disconnected or an error occurred
	done := make(chan struct{})

	// Goroutine 1: Read messages from the client
	go func() {
		defer close(done)
		for {
			messageType, p, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("WebSocket error: %v", err)
				}
				return // Exit goroutine
			}
			if messageType == websocket.BinaryMessage {
				samples := pcm16ToFloat32(p)
				recognizer.AcceptWaveform(samples)
			}
		}
	}()

	// Goroutine 2: Periodically fetch and send results to the client
	lastSentText := ""
	for {
		select {
		case <-done:
			log.Println("Client disconnected. Stopping result sender.")
			return
		case <-time.After(100 * time.Millisecond): // Check every 100ms
			text, isFinal := recognizer.GetResult()

			if text != "" && text != lastSentText {
				lastSentText = text
				// Send PARTIAL result for real-time feedback
				turnID := uuid.New().String()
				resp := SttResponse{Type: "PARTIAL", Text: text, TurnID: turnID}
				log.Printf("Sending PARTIAL result: %s", text)
				if err := conn.WriteJSON(resp); err != nil {
					log.Printf("Error sending PARTIAL STT result: %v", err)
					return // Stop on error
				}
			}

			if isFinal {
				if lastSentText != "" { // Ensure we have something to send
					turnID := uuid.New().String()
					resp := SttResponse{Type: "FINAL", Text: lastSentText, TurnID: turnID}
					log.Printf("Sending FINAL result: %s", lastSentText)
					if err := conn.WriteJSON(resp); err != nil {
						log.Printf("Error sending FINAL STT result: %v", err)
						return // Stop on error
					}
				}
				lastSentText = "" // Reset for the next utterance
			}
		}
	}
}

func sttHandler(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Failed to upgrade WebSocket: %v", err)
		return
	}
	defer conn.Close()

	handleSttConnection(conn)
}
