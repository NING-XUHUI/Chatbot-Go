package sttclient

import (
	"Chatbot-Go/internal/config"
	"log"
	"sync"

	sherpa "github.com/k2-fsa/sherpa-onnx-go-macos"
)

// Recognizer wraps the sherpa.OnlineRecognizer and sherpa.OnlineStream.
type Recognizer struct {
	recognizer *sherpa.OnlineRecognizer
	stream     *sherpa.OnlineStream
	mu         sync.Mutex
	lastText   string
}

// NewRecognizer creates a new Recognizer instance.
func NewRecognizer() (*Recognizer, error) {
	// 1. Create OnlineRecognizerConfig
	recognizerConfig := sherpa.OnlineRecognizerConfig{
		FeatConfig: sherpa.FeatureConfig{
			SampleRate: config.STTModelConfig.SampleRate,
			FeatureDim: 80,
		},
		ModelConfig: sherpa.OnlineModelConfig{
			Transducer: sherpa.OnlineTransducerModelConfig{
				Encoder: config.STTModelConfig.Encoder,
				Decoder: config.STTModelConfig.Decoder,
				Joiner:  config.STTModelConfig.Joiner,
			},
			Tokens:     config.STTModelConfig.Tokens,
			NumThreads: 1,
			Debug:      1,
		},
		EnableEndpoint:          1, // Use int instead of bool
		Rule1MinTrailingSilence: 1.2,
		Rule2MinTrailingSilence: 0.6,
		Rule3MinUtteranceLength: 300, // Roughly 3-4 syllables
	}

	// 2. Create the recognizer
	recognizer := sherpa.NewOnlineRecognizer(&recognizerConfig)

	// 3. Create the stream
	stream := sherpa.NewOnlineStream(recognizer)

	return &Recognizer{
		recognizer: recognizer,
		stream:     stream,
	}, nil
}

// AcceptWaveform feeds audio samples to the recognizer.
func (r *Recognizer) AcceptWaveform(samples []float32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stream.AcceptWaveform(config.STTModelConfig.SampleRate, samples)
}

// InputFinished signals that the utterance is finished.
func (r *Recognizer) InputFinished() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stream.InputFinished()
}

// GetResult fetches the latest recognition result and indicates if it's a final result from an endpoint.
func (r *Recognizer) GetResult() (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for r.recognizer.IsReady(r.stream) {
		r.recognizer.Decode(r.stream)
	}

	result := r.recognizer.GetResult(r.stream)
	isFinal := r.recognizer.IsEndpoint(r.stream)

	if isFinal {
		// IMPORTANT: After getting a final result, we reset the stream
		// to prepare for the next utterance.
		r.recognizer.Reset(r.stream)
		log.Println("VAD endpoint detected, result is final. Stream has been reset.")
	}

	return result.Text, isFinal
}

// Reset clears the internal state of the stream.
func (r *Recognizer) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recognizer.Reset(r.stream)
	log.Println("Recognizer stream reset manually.")
}

// Close releases the resources used by the recognizer.
func (r *Recognizer) Close() {
	sherpa.DeleteOnlineStream(r.stream)
	sherpa.DeleteOnlineRecognizer(r.recognizer)
}
