package config

var STTModelConfig = struct {
	Encoder  string
	Decoder  string
	Joiner   string
	Tokens   string
	Feat     string
	SampleRate int
}{
	Encoder:  "models/stt-model/encoder-epoch-99-avg-1.onnx",
	Decoder:  "models/stt-model/decoder-epoch-99-avg-1.onnx",
	Joiner:   "models/stt-model/joiner-epoch-99-avg-1.onnx",
	Tokens:   "models/stt-model/tokens.txt",
	Feat:     "models/stt-model/mel_feats.yaml",
	SampleRate: 16000,
}
