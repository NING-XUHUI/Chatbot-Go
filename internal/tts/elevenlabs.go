package tts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
)

const ttsURL = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream"

// Client for ElevenLabs API
type Client struct {
	apiKey string
	client *http.Client
}

// NewClient creates a new ElevenLabs client
func NewClient() (*Client, error) {
	// apiKey := os.Getenv("ELEVENLABS_API_KEY")
	apiKey := "sk_d64244d7a93ce5530086d592c0a9fc4b02f7e3735cd26ab8" // WARNING: For testing only. Do not commit to version control.
	if apiKey == "" || apiKey == "YOUR_ELEVENLABS_API_KEY_HERE" {
		return nil, fmt.Errorf("ELEVENLABS_API_KEY is not set in the source code")
	}
	return &Client{
		apiKey: apiKey,
		client: &http.Client{},
	}, nil
}

// GenerateStream sends text to ElevenLabs and streams the audio response
func (c *Client) GenerateStream(text string, writer io.Writer) error {
	payload := map[string]interface{}{
		"text":     text,
		"model_id": "eleven_multilingual_v2",
		"voice_settings": map[string]float64{
			"stability":        0.5,
			"similarity_boost": 0.8,
		},
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	req, err := http.NewRequest("POST", ttsURL, bytes.NewBuffer(jsonPayload))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("xi-api-key", c.apiKey)
	req.Header.Set("Accept", "audio/mpeg")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to perform request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("ElevenLabs API Error: %s", string(bodyBytes))
		return fmt.Errorf("elevenlabs API returned non-200 status: %d", resp.StatusCode)
	}

	// Stream the body to the provided writer
	_, err = io.Copy(writer, resp.Body)
	if err != nil {
		log.Printf("Error streaming TTS audio: %v", err)
		return err
	}

	return nil
}
