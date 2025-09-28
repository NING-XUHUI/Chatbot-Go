package llm

import (
	"context"
	"fmt"
	"os"

	genai "github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// GeminiClient wraps the generative model client
type GeminiClient struct {
	model *genai.GenerativeModel
}

// NewGeminiClient creates a new client for the Gemini API.
// It reads the API key from the GOOGLE_API_KEY environment variable.
func NewGeminiClient(ctx context.Context) (*GeminiClient, error) {
	apiKey := os.Getenv("GOOGLE_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GOOGLE_API_KEY environment variable not set")
	}

	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create genai client: %w", err)
	}

	model := client.GenerativeModel("gemini-2.5-flash") // Updated to a confirmed available and fast model
	temp := float32(1.0)
	model.GenerationConfig = genai.GenerationConfig{
		Temperature: &temp,
	}
	model.SafetySettings = []*genai.SafetySetting{
		{
			Category:  genai.HarmCategoryHarassment,
			Threshold: genai.HarmBlockOnlyHigh,
		},
		{
			Category:  genai.HarmCategoryHateSpeech,
			Threshold: genai.HarmBlockOnlyHigh,
		},
		{
			Category:  genai.HarmCategoryDangerousContent,
			Threshold: genai.HarmBlockOnlyHigh,
		},
		{
			Category:  genai.HarmCategorySexuallyExplicit,
			Threshold: genai.HarmBlockOnlyHigh,
		},
	}
	return &GeminiClient{model: model}, nil
}

// GenerateStream starts a streaming generation from Gemini.
// It returns an iterator that can be used to receive text parts.
func (c *GeminiClient) GenerateStream(prompt string) *genai.GenerateContentResponseIterator {
	ctx := context.Background()
	return c.model.GenerateContentStream(ctx, genai.Text(prompt))
}
