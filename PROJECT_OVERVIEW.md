# Chatbot-Go 智能语音对话系统

## 项目简介

这是一个基于Go语言后端和Next.js前端的实时智能语音对话系统，支持**语音转文字(STT)**、**大语言模型对话(LLM)**、**文字转语音(TTS)**。

## 核心特性

### 实时语音交互
- **语音识别(STT)**: 使用Sherpa-ONNX本地语音识别引擎，支持实时转录
- **语音合成(TTS)**: 集成ElevenLabs API，生成高质量语音
- **智能对话**: 基于Google Gemini 2.5 Flash模型的流式对话生成

### 流式处理架构
- **SSE流式响应**: LLM生成内容实时推送
- **音频流式播放**: 使用MediaSource API实现低延迟音频播放
- **WebSocket双向通信**: STT的实时传输

## 技术架构

### 当前架构(单体架构)
```
cmd/
├── gateway/           # 主服务入口 (端口:8080) - 包含所有功能
├── stt/              # 语音识别服务 (空文件)
└── responder/        # 响应处理服务 (空文件)

internal/
├── llm/              # Gemini AI集成
│   └── gemini.go     # Google Gemini 2.5 Flash客户端
├── tts/              # ElevenLabs TTS集成
│   └── elevenlabs.go # 文字转语音API客户端
├── sttclient/        # Sherpa-ONNX STT客户端
│   └── recognizer.go # 本地语音识别引擎
├── transport/        # HTTP/WebSocket传输层
│   ├── http.go       # REST API和SSE端点
│   └── websocket.go  # WebSocket连接处理
└── config/           # 配置管理
```

### 目标微服务架构
```
Chatbot-Go/
├── cmd/
│   ├── gateway/
│   │   └── main.go           # 只做路由转发，不包含业务逻辑
│   ├── llm-service/
│   │   └── main.go           # 独立的LLM服务 (端口:8081)
│   ├── tts-service/
│   │   └── main.go           # 独立的TTS服务 (端口:8082)
│   ├── stt-service/
│   │   └── main.go           # 独立的STT服务 (端口:8083)
│   └── interrupt-service/
│       └── main.go           # 中断管理服务 (端口:8084)
├── internal/
│   ├── gateway/             # 新增：gateway专用逻辑
│   │   ├── router.go        # 路由配置
│   │   ├── proxy.go         # 服务代理
│   │   └── loadbalancer.go  # 负载均衡
│   ├── llm/                 # LLM服务专用
│   │   ├── service.go       # HTTP服务器
│   │   ├── handler.go       # 请求处理
│   │   └── gemini.go        # Gemini客户端
│   ├── tts/                 # TTS服务专用
│   │   ├── service.go       # HTTP服务器
│   │   ├── handler.go       # 请求处理
│   │   └── elevenlabs.go    # ElevenLabs客户端
│   ├── stt/                 # STT服务专用
│   │   ├── service.go       # HTTP/WebSocket服务器
│   │   ├── handler.go       # 请求处理
│   │   └── recognizer.go    # 语音识别引擎
│   ├── interrupt/           # 中断服务专用
│   │   ├── service.go       # WebSocket服务器
│   │   ├── manager.go       # 中断状态管理
│   │   └── handler.go       # 中断处理
│   ├── shared/              # 新增：共享组件
│   │   ├── config/          # 配置管理
│   │   ├── middleware/      # 中间件
│   │   ├── logger/          # 日志
│   │   └── errors/          # 错误处理
│   └── proto/               # 新增：服务间通信协议
│       ├── llm.proto        # LLM服务接口定义
│       ├── tts.proto        # TTS服务接口定义
│       └── stt.proto        # STT服务接口定义
├── deployments/             # 新增：部署配置
│   ├── docker/
│   │   ├── gateway.Dockerfile
│   │   ├── llm.Dockerfile
│   │   ├── tts.Dockerfile
│   │   └── stt.Dockerfile
│   ├── k8s/                 # Kubernetes配置
│   └── docker-compose.yml   # 本地开发环境
└── scripts/                 # 新增：构建和部署脚本
    ├── build.sh
    ├── deploy.sh
    └── run-dev.sh
```

### 服务端口分配
```
Gateway:     8080  (对外入口)
LLM Service: 8081  (内部服务)
TTS Service: 8082  (内部服务)
STT Service: 8083  (内部服务)
Interrupt:   8084  (内部服务)
```

### 前端架构(Next.js + React)
```
web/
├── src/app/
│   └── page.tsx      # 主要的React组件，包含所有交互逻辑
├── next.config.ts    # Next.js配置，包含API代理设置
└── package.json      # 依赖管理
```

## 关键组件详解

### 1. 语音识别系统(STT)
**文件**: `internal/sttclient/recognizer.go`
- 基于Sherpa-ONNX的离线识别引擎
- 实时音频流处理和文本转录
- 支持VAD(语音活动检测)和端点识别
- 可配置的静音容忍时间

### 2. 大语言模型对话
**文件**: `internal/llm/gemini.go`
- Google Gemini 2.5 Flash模型集成
- 支持流式内容生成
- 配置安全设置和生成参数
- 实时SSE推送给前端

### 3. 语音合成系统(TTS)
**文件**: `internal/tts/elevenlabs.go`
- ElevenLabs多语言TTS API
- 流式音频生成和传输

### 4. 前端语音处理
**文件**: `web/src/app/page.tsx`

**关键功能模块**:
- **MediaSource音频播放**: 流式音频缓冲和播放控制
- **WebSocket通信**: STT的双向传输
- **状态管理**: React Hooks管理复杂的音频和对话状态

## 核心技术亮点

### 1. 流式音频播放
```typescript
// MediaSource实时音频队列管理
const processAudioQueue = () => {
    if (!isAppending.current && audioQueue.current.length > 0) {
        const chunk = audioQueue.current.shift();
        sourceBufferRef.current.appendBuffer(chunk);
    }
};
```


## API端点

### HTTP/SSE端点
- `POST /sse/llm` - LLM流式对话
- `POST /stream/tts` - TTS音频流
- `GET /ping` - 健康检查

### WebSocket端点
- `GET /ws/stt` - 语音识别WebSocket

## 环境配置

### 系统要求
- **Go**: 1.25+
- **Node.js**: 18+
- **macOS**: 支持Sherpa-ONNX模型

### API密钥配置
```bash
export GOOGLE_API_KEY="your_gemini_api_key"
export ELEVENLABS_API_KEY="your_elevenlabs_api_key"
```

### 依赖项
**Go依赖**:
- `github.com/gin-gonic/gin` - Web框架
- `github.com/google/generative-ai-go` - Gemini AI客户端
- `github.com/gorilla/websocket` - WebSocket支持
- `github.com/k2-fsa/sherpa-onnx-go-macos` - 语音识别引擎

**前端依赖**:
- `next` - React框架
- `react` - UI库
- `lucide-react` - 图标库

## 运行指南

### 1. 启动后端服务
```bash
cd /Volumes/Workspace/study/Chatbot-Go
go run cmd/gateway/main.go
```
服务将在 `localhost:8080` 启动

### 2. 启动前端服务
```bash
cd web
npm install
npm run dev
```
前端将在 `localhost:3000` 启动

### 3. 访问应用
打开浏览器访问 `http://localhost:3000`

## 项目特色

1. **低延迟交互**: 全流式处理架构，最小化响应时间
2. **本地语音识别**: 使用Sherpa-ONNX，无需依赖云端STT服务
3. **高质量语音**: ElevenLabs生成的自然、清晰语音
4. **健壮的错误处理**: 完善的异常恢复和状态管理机制
5. **实时状态同步**: 前后端状态实时同步，确保用户体验一致性

## 技术创新点

### 1. MediaSource流式播放
使用现代Web API实现低延迟的音频流播放和精确控制。

### 2. 本地语音识别
使用Sherpa-ONNX实现高质量的离线语音识别，降低对网络的依赖。

## 适用场景

- **AI客服系统**: 提供自然的语音交互体验
- **教育应用**: 语音问答和互动学习
- **智能助手**: 个人或企业级语音助手
- **语音测试平台**: 语音技术的开发和测试

## 架构演进规划

### 微服务化的优势
1. **独立部署**: 每个服务可以独立更新和扩展
2. **资源隔离**: 不同服务可以有不同的资源配置
3. **技术栈灵活**: 未来可以用不同语言重写某个服务
4. **故障隔离**: 单个服务故障不会影响整个系统
5. **水平扩展**: 可以针对瓶颈服务进行扩展

### 服务间通信流程
```
Frontend → Gateway:8080 → HTTP请求 → LLM Service:8081
                        → HTTP请求 → TTS Service:8082
                        → WebSocket → STT Service:8083
```

## 总结

这个项目展示了现代语音AI系统的完整实现，从底层音频处理到高级AI对话，涵盖了实时语音交互的各个技术环节。项目当前采用单体架构，便于开发和调试，同时规划了清晰的微服务演进路径，为构建高效、可扩展的语音对话系统提供了宝贵的参考和实践经验。

项目代码结构清晰，技术选型合理，既适合学习实时语音交互技术，也为生产环境的微服务架构演进提供了完整的蓝图。