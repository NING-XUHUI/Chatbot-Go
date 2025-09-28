package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"Chatbot-Go/internal/llm"
	"Chatbot-Go/internal/tts"

	"sync"

	"github.com/gin-gonic/gin"
	"github.com/google/generative-ai-go/genai"
	"github.com/gorilla/websocket"
	"google.golang.org/api/iterator"
)

// InterruptManager manages the interruption signals.
type InterruptManager struct {
	mu          sync.Mutex
	interrupted map[string]bool
	globalStop  bool // 全局停止标志，可以停止所有正在进行的TTS
}

func (im *InterruptManager) Set(turnID string) {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.interrupted[turnID] = true
	// 设置全局停止标志，立即停止所有正在进行的TTS
	im.globalStop = true
	log.Printf("设置全局停止标志，turnID: %s", turnID)
}

func (im *InterruptManager) Check(turnID string) bool {
	im.mu.Lock()
	defer im.mu.Unlock()
	// 检查特定turnID或全局停止标志
	return im.interrupted[turnID] || im.globalStop
}

func (im *InterruptManager) Clear(turnID string) {
	im.mu.Lock()
	defer im.mu.Unlock()
	delete(im.interrupted, turnID)
}

func (im *InterruptManager) ClearGlobalStop() {
	im.mu.Lock()
	defer im.mu.Unlock()
	im.globalStop = false
	log.Printf("清除全局停止标志")
}

var interruptManager = &InterruptManager{
	interrupted: make(map[string]bool),
}

// flushWriter is a helper to flush the response writer after every write.
type flushWriter struct {
	writer  io.Writer
	flusher http.Flusher
}

func (fw *flushWriter) Write(p []byte) (n int, err error) {
	n, err = fw.writer.Write(p)
	if err != nil {
		return n, err
	}
	fw.flusher.Flush()
	return n, nil
}

// interruptableWriter wraps a writer and checks for interruption.
type interruptableWriter struct {
	writer io.Writer
	turnID string
}

func (iw *interruptableWriter) Write(p []byte) (n int, err error) {
	if interruptManager.Check(iw.turnID) {
		log.Printf("Interrupt detected for turnID: %s. Stopping stream.", iw.turnID)
		return 0, fmt.Errorf("stream interrupted for turnID %s", iw.turnID)
	}
	return iw.writer.Write(p)
}

func llmHandler(c *gin.Context) {
	// 1. Set up SSE headers
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("Access-Control-Allow-Origin", "*") // For development

	// 2. Read the prompt from the request body
	var requestBody struct {
		Prompt string `json:"prompt"`
	}
	if err := c.ShouldBindJSON(&requestBody); err != nil {
		log.Printf("Error binding JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// 3. Initialize Gemini Client
	geminiClient, err := llm.NewGeminiClient(context.Background())
	if err != nil {
		log.Printf("Error creating Gemini client: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to initialize LLM service"})
		return
	}

	// 4. Start streaming from Gemini and forward to client
	c.Stream(func(w io.Writer) bool {
		iter := geminiClient.GenerateStream(requestBody.Prompt)
		for {
			resp, err := iter.Next()
			if err == iterator.Done {
				return false // End of stream
			}
			if err != nil {
				log.Printf("Error receiving from Gemini stream: %v", err)
				return false
			}

			var textPart string
			if len(resp.Candidates) > 0 && resp.Candidates[0].Content != nil && len(resp.Candidates[0].Content.Parts) > 0 {
				if txt, ok := resp.Candidates[0].Content.Parts[0].(genai.Text); ok {
					textPart = string(txt)
				}
			}

			if textPart == "" {
				continue
			}

			// Define a struct for the JSON payload
			payload := struct {
				Text string `json:"text"`
			}{
				Text: textPart,
			}

			// Marshal the payload to JSON
			jsonPayload, err := json.Marshal(payload)
			if err != nil {
				log.Printf("Error marshalling JSON: %v", err)
				continue // Skip this chunk on marshalling error
			}

			// Format as SSE
			sseMessage := fmt.Sprintf("data: %s\n\n", jsonPayload)
			_, err = w.Write([]byte(sseMessage))
			if err != nil {
				log.Printf("Error writing to stream: %v", err)
				return false
			}
		}
	})

	log.Println("LLM stream finished for client.")
}

func RegisterTransportRoutes(r *gin.Engine) {
	r.POST("/sse/llm", llmHandler)
	r.POST("/stream/tts", ttsHandler) // This will be handled by Next.js API route
	r.GET("/ws/stt", sttHandler)
	r.GET("/ping", pingHandler)
	r.GET("/ws/interrupt", interruptHandler)
}

// ttsHandler is no longer used from here.
func ttsHandler(c *gin.Context) {
	var reqBody struct {
		Text   string `json:"text"`
		TurnID string `json:"turn_id"`
	}
	if err := c.ShouldBindJSON(&reqBody); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	turnID := reqBody.TurnID

	// 清除全局停止标志，允许新的TTS请求开始
	interruptManager.ClearGlobalStop()

	defer interruptManager.Clear(turnID) // Ensure cleanup after the request is done.

	log.Printf("Received text for TTS: '%s' for turnID: %s", reqBody.Text, turnID)
	if reqBody.Text == "" {
		log.Println("TTS request has empty text, returning.")
		c.Status(http.StatusBadRequest)
		return
	}

	client, err := tts.NewClient()
	if err != nil {
		log.Printf("Error creating TTS client: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not initialize TTS client"})
		return
	}

	c.Header("Content-Type", "audio/mpeg")

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Streaming unsupported"})
		return
	}

	flushingWriter := &flushWriter{
		writer:  c.Writer,
		flusher: flusher,
	}

	interruptWriter := &interruptableWriter{
		writer: flushingWriter,
		turnID: turnID,
	}

	err = client.GenerateStream(reqBody.Text, interruptWriter)
	if err != nil {
		// We expect an "interrupted" error here, so we don't need to log it as a critical failure.
		if err.Error() != fmt.Sprintf("stream interrupted for turnID %s", turnID) {
			log.Printf("Error generating TTS stream: %v", err)
		}
	}
}

func interruptHandler(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Failed to upgrade interrupt WebSocket: %v", err)
		return
	}
	defer conn.Close()
	log.Println("Client connected to interrupt WebSocket.")

	for {
		_, p, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Interrupt WebSocket error: %v", err)
			}
			break
		}

		var msg struct {
			Action string `json:"action"`
			TurnID string `json:"turn_id"`
		}

		if err := json.Unmarshal(p, &msg); err == nil && msg.Action == "interrupt" {
			log.Printf("Received interrupt signal for turn_id: %s", msg.TurnID)
			interruptManager.Set(msg.TurnID)
		}
	}
}

func pingHandler(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"message": "pong"})
}
