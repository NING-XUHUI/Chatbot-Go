"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Mic } from 'lucide-react';

interface Message {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('正在连接WebSocket...');
  const [messages, setMessages] = useState<Message[]>([]);
  const [transcript, setTranscript] = useState('');
  const [volume, setVolume] = useState(0);
  const isAssistantSpeakingRef = useRef(false);
  const assistantSpeakingStartTime = useRef<number>(0);
  const currentTurnIdRef = useRef<string>('');

  const ws = useRef<WebSocket | null>(null);
  const interruptWs = useRef<WebSocket | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const eventSource = useRef<EventSource | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioQueue = useRef<ArrayBuffer[]>([]);
  const isAppending = useRef(false);
  const abortController = useRef<AbortController | null>(null);
  const isInterruptingRef = useRef(false); // 安全锁

  const sendInterruptSignal = (turnId: string) => {
    console.log(`尝试发送打断信号`, {
      turnId,
      wsState: interruptWs.current?.readyState,
      wsOpen: interruptWs.current?.readyState === WebSocket.OPEN
    });

    if (interruptWs.current?.readyState === WebSocket.OPEN) {
      const message = {
        action: 'interrupt',
        turn_id: turnId
      };
      interruptWs.current.send(JSON.stringify(message));
      console.log(`打断信号已发送`, message);
    } else {
      console.log(`WebSocket连接不可用，状态: ${interruptWs.current?.readyState}`);
    }
  };

  const forceStopAudio = async () => {
    console.log("强制停止本地音频播放，当前turnID:", currentTurnIdRef.current);

    // 1. 立即停止AbortController中的请求
    if (abortController.current) {
      console.log("强制中止AbortController，signal之前状态:", abortController.current.signal.aborted ? "已中止" : "正常");
      abortController.current.abort();
      console.log("AbortController 已停止");
    }

    // 2. 发送打断信号到后端停止TTS生成
    if (currentTurnIdRef.current) {
      sendInterruptSignal(currentTurnIdRef.current);
      console.log("发送打断信号，turnID:", currentTurnIdRef.current);
    } else {
      console.warn("没有当前turnID，无法发送打断信号");
    }

    // 3. 强制停止音频播放器，但保持MediaSource结构
    if (audioPlayerRef.current) {
      const player = audioPlayerRef.current;
      player.pause();
      player.currentTime = 0; // 重置播放位置
      player.volume = 0; // 立即静音
      console.log("本地播放已强制停止并静音");

      // 短暂延迟后恢复音量，准备下次播放
      setTimeout(() => {
        if (audioPlayerRef.current && !isAssistantSpeakingRef.current) {
          audioPlayerRef.current.volume = 1;
          console.log("音量已恢复，准备下次播放");
        }
      }, 200);
    }

    // 4. 温和地清理SourceBuffer中的缓存数据
    if(sourceBufferRef.current && mediaSourceRef.current) {
      try {
        if (sourceBufferRef.current.updating) {
          sourceBufferRef.current.abort();
          console.log("SourceBuffer 更新已停止");
        }

        // 如果有缓存数据，尝试清除
        if (sourceBufferRef.current.buffered.length > 0) {
          const bufferedStart = sourceBufferRef.current.buffered.start(0);
          const bufferedEnd = sourceBufferRef.current.buffered.end(sourceBufferRef.current.buffered.length - 1);
          try {
            sourceBufferRef.current.remove(bufferedStart, bufferedEnd);
            console.log(`清空SourceBuffer缓存数据: ${bufferedStart}s 到 ${bufferedEnd}s`);
          } catch (removeErr) {
            console.warn("SourceBuffer清理失败，将在下次播放时自然覆盖:", removeErr);
          }
        }
      } catch (_e) {
        console.warn("SourceBuffer处理时出现错误，系统仍可正常工作:", _e);
      }
    }

    // 5. 清空待播放的音频队列
    const queueLength = audioQueue.current.length;
    audioQueue.current = [];
    isAppending.current = false;
    console.log(`清空音频队列，清理了 ${queueLength} 个音频块`);

    // 6. 立即重置assistant说话状态
    setAssistantSpeaking(false);
    console.log("强制重置assistant状态为停止");

    // 7. 清空当前turnID，防止后续误操作
    // 不清空当前turnID，让handleAssistantResponse的finally块来处理状态
    console.log("保持当前turnID用于状态同步:", currentTurnIdRef.current);

    console.log("音频停止完成，保持音频系统稳定");
  };

  const setAssistantSpeaking = (speaking: boolean) => {
    console.log(`assistant说话状态变更: ${speaking ? '开始' : '结束'}`, {
      speaking,
      currentTurnId: currentTurnIdRef.current,
      wasInterrupting: isInterruptingRef.current
    });
    isAssistantSpeakingRef.current = speaking;
    if (speaking) {
      // assistant开始说话时记录时间
      assistantSpeakingStartTime.current = Date.now();
      console.log("assistant开始说话时间:", assistantSpeakingStartTime.current);
    } else {
      // assistant停止说话时重置中断状态
      isInterruptingRef.current = false;
      assistantSpeakingStartTime.current = 0;
    }
  };

  const processAudioQueue = () => {
    if (!isAppending.current && audioQueue.current.length > 0 && sourceBufferRef.current && !sourceBufferRef.current.updating) {
      // 检查MediaSource和SourceBuffer的状态
      if (mediaSourceRef.current?.readyState !== 'open') {
        console.warn("MediaSource不在open状态，跳过音频处理");
        return;
      }

      isAppending.current = true;
      const audioData = audioQueue.current.shift();
      if (audioData) {
        console.log("处理音频队列，数据大小:", audioData.byteLength, "队列剩余:", audioQueue.current.length);
        try {
          sourceBufferRef.current.appendBuffer(audioData);
        } catch (e) {
          console.error('SourceBuffer错误:', e);
          isAppending.current = false;

          // 如果SourceBuffer出错，尝试重新初始化音频播放系统
          console.log("尝试重新初始化音频播放系统...");
          resetAudioPlayback().then(() => {
            console.log("音频播放系统重新初始化完成");
          });
        }
      } else {
        isAppending.current = false;
      }
    } else {
      if (audioQueue.current.length > 0) {
        console.log("音频队列等待处理，队列长度:", audioQueue.current.length, "是否正在追加:", isAppending.current, "SourceBuffer更新中:", sourceBufferRef.current?.updating);
      }
    }
  };

  const resetAudioPlayback = (forceStop = false) => {
    return new Promise<void>((resolve) => {
      console.log(`重置音频播放系统, forceStop: ${forceStop}`);

      // 清理现有的播放器
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        if (audioPlayerRef.current.src && audioPlayerRef.current.src.startsWith('blob:')) {
          URL.revokeObjectURL(audioPlayerRef.current.src);
        }
        audioPlayerRef.current = null;
      }

      // 清理现有的MediaSource
      if (mediaSourceRef.current) {
        try {
          if (mediaSourceRef.current.readyState === 'open') {
            mediaSourceRef.current.endOfStream();
          }
        } catch (_e) {
          // 忽略错误
        }
        mediaSourceRef.current = null;
      }

      if (forceStop) {
        console.log("强制停止播放，并销毁播放器");
        sourceBufferRef.current = null;
        audioQueue.current = [];
        isAppending.current = false;
        resolve();
        return;
      }

      // 重置所有状态
      sourceBufferRef.current = null;
      audioQueue.current = [];
      isAppending.current = false;

      // 创建新的播放器和MediaSource
      audioPlayerRef.current = new Audio();
      mediaSourceRef.current = new MediaSource();
      const mediaSource = mediaSourceRef.current;
      const audio = audioPlayerRef.current;

      // 添加音频事件监听器
      audio.addEventListener('play', () => {
        console.log("音频播放事件触发");
        setAssistantSpeaking(true); // 音频开始播放时设置assistant状态
      });

      audio.addEventListener('pause', () => {
        console.log("音频暂停事件触发");
        setAssistantSpeaking(false); // 暂停时清除assistant状态
      });

      audio.addEventListener('ended', () => {
        console.log("音频播放结束");
        setAssistantSpeaking(false); // 播放结束时清除assistant状态
      });

      audio.addEventListener('error', (e) => {
        console.error("音频播放错误:", e);
        setAssistantSpeaking(false); // 播放错误时清除assistant状态
      });

      const onSourceOpen = () => {
        mediaSource.removeEventListener('sourceopen', onSourceOpen);
        try {
          const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          sourceBuffer.addEventListener('updateend', () => {
            isAppending.current = false;
            processAudioQueue();

            // 检查是否有音频数据并开始播放
            if (audio.paused && audio.buffered.length > 0 && audio.buffered.end(0) > 0.1) {
              audio.play().then(() => {
                console.log("音频自动开始播放");
                // assistant状态会通过'play'事件自动设置，不需要在这里重复设置
              }).catch(e => {
                console.warn("音频播放失败:", e);
                console.log("播放失败，可能需要重置音频系统");
                setAssistantSpeaking(false); // 播放失败时确保清除assistant状态
              });
            }
          });
          sourceBufferRef.current = sourceBuffer;
          console.log("新的音频播放系统初始化完成");
          resolve();
        } catch (e) {
          console.error('Exception creating SourceBuffer during reset:', e);
          resolve();
        }
      };

      const onSourceError = (e: Event) => {
        console.error('MediaSource error during reset:', e);
        mediaSource.removeEventListener('sourceopen', onSourceOpen);
        mediaSource.removeEventListener('error', onSourceError);
        resolve();
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen);
      mediaSource.addEventListener('error', onSourceError);
      audio.src = URL.createObjectURL(mediaSource);
    });
  };

  useEffect(() => {
    resetAudioPlayback();
    // 确保初始状态正确
    setAssistantSpeaking(false);
    console.log("初始化assistant状态为停止");
  }, []);

  const cleanup = () => {
    if (processor.current) {
      processor.current.disconnect();
      processor.current = null;
    }
    if (audioContext.current?.state !== 'closed') {
      audioContext.current?.close();
    }
    if (mediaStream.current) {
      mediaStream.current.getTracks().forEach(track => track.stop());
      mediaStream.current = null;
    }
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.close();
    }
    setIsRecording(false);
    setStatus("已连接");
  };

  const connectInterruptWebSocket = (url: string) => {
    interruptWs.current = new WebSocket(url);
    interruptWs.current.onopen = () => {
      console.log('Interrupt WebSocket 连接已建立');
    };
    interruptWs.current.onclose = () => {
      console.log('Interrupt WebSocket 连接断开，正在尝试重新连接...');
      setTimeout(() => connectInterruptWebSocket(url), 5000);
    };
    interruptWs.current.onerror = (error) => {
      console.error('Interrupt WebSocket 错误:', error);
      interruptWs.current?.close();
    };
  };

  useEffect(() => {
    // 直接连接到后端服务器，因为WebSocket代理在Next.js中不太稳定
    const wsUrl = `ws://localhost:8080/ws/stt`;
    const interruptUrl = `ws://localhost:8080/ws/interrupt`;
    connectWebSocket(wsUrl);
    connectInterruptWebSocket(interruptUrl);
    return () => {
      ws.current?.close();
      interruptWs.current?.close();
      eventSource.current?.close();
    };
  }, []);

  const handleAssistantResponse = async (turnId: string, finalTranscript: string) => {
    console.log("开始新的assistant响应，turnID:", turnId);

    // 清理之前的状态，确保新请求干净开始
    if (abortController.current) {
      abortController.current.abort();
    }

    // 清空之前的音频队列，确保不会播放旧内容
    const oldQueueLength = audioQueue.current.length;
    audioQueue.current = [];
    isAppending.current = false;
    if (oldQueueLength > 0) {
      console.log(`清理旧音频队列，清理了 ${oldQueueLength} 个音频块`);
    }

    // 为每个新的assistant响应重新初始化音频系统，确保干净的播放环境
    console.log("为新的assistant响应重新初始化音频系统...");
    await resetAudioPlayback();
    console.log("音频系统重新初始化完成，准备接收新音频");

    // 确保音频播放器处于正确状态
    if (audioPlayerRef.current) {
      console.log("检查音频播放器状态，当前音量:", audioPlayerRef.current.volume, "播放位置:", audioPlayerRef.current.currentTime);
      audioPlayerRef.current.volume = 1; // 确保音量正常
      if (audioPlayerRef.current.paused && audioPlayerRef.current.currentTime > 0) {
        console.log("重置播放位置从", audioPlayerRef.current.currentTime, "到 0");
        audioPlayerRef.current.currentTime = 0; // 重置播放位置
      }
      console.log("音频播放器状态已重置");
    }

    abortController.current = new AbortController();
    const signal = abortController.current.signal;
    console.log("创建新的AbortController，signal状态:", signal.aborted ? "已中止" : "正常");
    currentTurnIdRef.current = turnId; // 保存当前轮次ID用于打断
    // 不在这里设置assistant状态，等实际音频播放时再设置
    console.log("准备assistant响应，turnID:", turnId);

    try {
      const newAssistantMessage: Message = { id: `assistant-${turnId}`, text: "", sender: "assistant" };
      setMessages(prev => [...prev, newAssistantMessage]);

      const llmResponse = await fetch('/sse/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: finalTranscript }),
        signal,
      });

      if (!llmResponse.body) return;

      const reader = llmResponse.body.pipeThrough(new TextDecoderStream()).getReader();
      let fullText = '';
      let buffer = '';

      const processStream = () => {
        reader.read().then(async ({ value, done }) => {
          if (signal.aborted) {
            return;
          }
          if (done) {
            if (fullText) {
              console.log("开始请求TTS，文本长度:", fullText.length, "turnID:", turnId);
              console.log("TTS请求signal状态:", signal.aborted ? "已中止" : "正常");

              const ttsResponse = await fetch('/stream/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText, turn_id: turnId }),
                signal,
              });

              console.log("TTS响应状态:", ttsResponse.status, ttsResponse.ok ? "成功" : "失败");

              if (!ttsResponse.ok) return;

              if (ttsResponse.body) {
                const audioReader = ttsResponse.body.getReader();
                console.log("TTS流开始，准备接收音频数据，turnID:", turnId);

                try {
                  while (true) {
                    if (signal.aborted) {
                      console.log("检测到signal中断，取消TTS流，turnID:", turnId);
                      audioReader.cancel();
                      break;
                    }

                    const { done: audioDone, value: audioValue } = await audioReader.read();

                    if (audioDone) {
                      console.log("TTS流正常结束，turnID:", turnId);
                      break;
                    }

                    if (audioValue) {
                      console.log("接收到音频数据块，大小:", audioValue.byteLength, "turnID:", turnId);
                      audioQueue.current.push(audioValue.buffer);
                      processAudioQueue();
                    }
                  }
                } catch (error) {
                  console.error("TTS流读取错误:", error, "turnID:", turnId);
                  if ((error as Error).name !== 'AbortError') {
                    // 只有非AbortError才需要特殊处理
                    console.error("TTS流意外错误:", error);
                  }
                }
              }
            }
            return;
          }

          buffer += value;
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const message = buffer.substring(0, boundary);
            buffer = buffer.substring(boundary + 2);

            if (message.startsWith('data: ')) {
              const jsonString = message.substring(6);
              try {
                const parsed = JSON.parse(jsonString);
                if (parsed.text) {
                  fullText += parsed.text;
                  setMessages(prev =>
                    prev.map(msg =>
                      msg.id === `assistant-${turnId}` ? { ...msg, text: fullText } : msg
                    )
                  );
                }
              } catch (e) { console.error("Error parsing SSE JSON:", e); }
            }
            boundary = buffer.indexOf('\n\n');
          }

          processStream();
        }).catch(err => {
          if (err.name !== 'AbortError') {
            console.error("Stream reading error:", err);
          }
        });
      };

      processStream();

    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error("Error in assistant response handler:", error);
      }
    } finally {
      // 清理turnID，但不直接设置assistant状态（让音频事件处理）
      if (abortController.current?.signal.aborted) {
        console.log("assistant响应被中断，保持turnID用于后续处理");
      } else {
        console.log("assistant响应正常结束，清理turnID");
        currentTurnIdRef.current = ''; // 清空turnId避免误发送打断信号
        // assistant状态由音频播放事件控制，不在这里直接设置
      }
      isInterruptingRef.current = false; // 解锁：确保一次完整的assistant回应后，中断锁被打开
    }
  };

  const connectWebSocket = (url: string) => {
    ws.current = new WebSocket(url);
    ws.current.onopen = () => setStatus('已连接，请点击麦克风开始对话');
    ws.current.onclose = () => {
      setStatus('连接已断开，正在尝试重新连接...');
      setTimeout(() => connectWebSocket(url), 5000);
    };
    ws.current.onerror = (error) => {
      setStatus('连接错误');
      console.error('WebSocket error:', error);
      ws.current?.close();
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'PARTIAL') {
        setTranscript(data.text);
      } else if (data.type === 'FINAL') {
        setTranscript('');
        if (data.text.trim()) {
          setMessages(prev => [...prev, { id: `user-${data.turn_id}`, sender: 'user', text: data.text }]);
          handleAssistantResponse(data.turn_id, data.text);
        }
      }
    };
  };

  const toggleRecording = async () => {
    if (isRecording) {
      cleanup();
    } else {
      if (isAssistantSpeakingRef.current) {
        console.log("检测到assistant正在说话，执行打断...");
        await forceStopAudio();
        // 等待一小段时间确保打断完成
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 在开始新的录音前，确保有一个可用的播放器实例
      if (!audioPlayerRef.current || !sourceBufferRef.current || mediaSourceRef.current?.readyState !== 'open') {
        console.log("音频系统需要初始化...");
        await resetAudioPlayback();
      }

      // 尝试播放来解锁音频权限
      audioPlayerRef.current?.play().catch(e => {
        if ((e as Error).name !== 'AbortError') {
          console.error("音频播放解锁失败:", e)
        }
      });
      startRecording();
    }
  };

  const startRecording = () => {
    if (isRecording) return;
    isInterruptingRef.current = false; 
    setIsRecording(true);
    setStatus("正在聆听...");

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false, // 关闭噪声抑制，提高敏感度
        autoGainControl: false,  // 关闭自动增益，手动控制
        channelCount: 1,
        sampleRate: 16000,
        // Chrome specific constraints
        ...({
          googEchoCancellation: true,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
        } as Record<string, boolean>)
      }
    }).then(stream => {
        mediaStream.current = stream;
        audioContext.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: AudioContext }).webkitAudioContext)({ sampleRate: 16000 });
        if (!audioContext.current) return;
        
        const source = audioContext.current.createMediaStreamSource(stream);
        const gainNode = audioContext.current.createGain();
        processor.current = audioContext.current.createScriptProcessor(4096, 1, 1);

        source.connect(gainNode);
        gainNode.connect(processor.current);
        processor.current.connect(audioContext.current.destination);

        const VOLUME_THRESHOLD = 0.003; // 进一步降低音量阈值，更加灵敏
        const recentVolumes: number[] = []; // 用于平滑音量检测

        processor.current.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);

          // 1. RMS音量检测
          let sum = 0;
          for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / inputData.length);

          // 2. 峰值检测
          let peak = 0;
          for (let i = 0; i < inputData.length; i++) {
            const abs = Math.abs(inputData[i]);
            if (abs > peak) peak = abs;
          }

          // 3. 高频能量检测（更容易检测到人声）
          let highFreqEnergy = 0;
          for (let i = inputData.length / 2; i < inputData.length; i++) {
            highFreqEnergy += inputData[i] * inputData[i];
          }
          const highFreqRms = Math.sqrt(highFreqEnergy / (inputData.length / 2));

          // 4. 综合音量检测 - 使用多个指标的最大值
          const combinedVolume = Math.max(rms, peak * 0.3, highFreqRms * 1.5);

          // 5. 音量平滑处理 (用于显示)
          recentVolumes.push(combinedVolume);
          if (recentVolumes.length > 3) { // 减少平滑窗口，更快响应
            recentVolumes.shift();
          }
          const smoothedVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

          setVolume(smoothedVolume); 

          // 动态调整麦克风增益 - 提高assistant说话时的检测能力
          if (isAssistantSpeakingRef.current) {
            gainNode.gain.value = 2.5; // 大幅提高增益以更好检测人声
          } else {
            gainNode.gain.value = 1.0; // 正常灵敏度
          }
          
          if (ws.current?.readyState === WebSocket.OPEN) {
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              const s = Math.max(-1, Math.min(1, inputData[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            ws.current.send(pcm16.buffer);
          }

          // 添加assistant状态调试
          if (isAssistantSpeakingRef.current) {
            console.log(`assistant正在说话，音量数据:`, {
              smoothed: smoothedVolume.toFixed(5),
              peak: peak.toFixed(5),
              combined: combinedVolume.toFixed(5),
              rms: rms.toFixed(5),
              highFreq: highFreqRms.toFixed(5),
              threshold: VOLUME_THRESHOLD,
              interrupting: isInterruptingRef.current
            });
          }

          if (isAssistantSpeakingRef.current && !isInterruptingRef.current) {
            // 使用更激进的检测策略
            const isLoudEnough =
              smoothedVolume > VOLUME_THRESHOLD ||
              peak > VOLUME_THRESHOLD * 1.5 ||
              combinedVolume > VOLUME_THRESHOLD * 0.6 ||
              rms > VOLUME_THRESHOLD * 0.8 ||
              highFreqRms > VOLUME_THRESHOLD * 0.4; // 增加高频检测的权重

            if (isLoudEnough) {
              console.log(`声音检测达到阈值:`, {
                smoothed: smoothedVolume.toFixed(5),
                peak: peak.toFixed(5),
                combined: combinedVolume.toFixed(5),
                rms: rms.toFixed(5),
                highFreq: highFreqRms.toFixed(5),
                threshold: VOLUME_THRESHOLD
              });

              // 立即触发打断，不等待多次检测
              isInterruptingRef.current = true;
              console.log("检测到人声，立即触发打断！", {
                smoothedVolume,
                peak,
                combinedVolume,
                turnId: currentTurnIdRef.current
              });
              forceStopAudio(); // 立即打断
            }
          }
        };
      }).catch(err => {
        console.error("无法获取麦克风:", err);
        setIsRecording(false);
        setStatus("麦克风错误");
      });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 sm:p-24 bg-gray-900 text-white">
      <div className="flex flex-col h-[80vh] w-full max-w-2xl bg-gray-800 rounded-xl shadow-lg">
        <div className="flex-1 p-6 overflow-y-auto">
          <div className="space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`px-4 py-2 rounded-lg max-w-xs lg:max-w-md ${msg.sender === 'user' ? 'bg-blue-600' : 'bg-gray-700'}`}>
                  <p>{msg.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-6 border-t border-gray-700">
          <div className="text-center h-8 mb-4 text-gray-400">
            {transcript && <p>{transcript}</p>}
          </div>
          <div className="flex justify-center items-center gap-4">
             <div className="w-24 h-8 bg-gray-700 rounded-full overflow-hidden">
              {isRecording && (
                <div
                  className="h-full bg-green-500 transition-all duration-75"
                  style={{ width: `${Math.min(volume * 200, 100)}%` }}
                />
              )}
            </div>
            <button
              onClick={toggleRecording}
              disabled={status !== '已连接，请点击麦克风开始对话' && !isRecording}
              className={`p-4 rounded-full transition-colors ${
                (status !== '已连接，请点击麦克风开始对话' && !isRecording)
                  ? 'bg-gray-500 cursor-not-allowed'
                  : isRecording
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}>
              <Mic className="h-6 w-6" />
            </button>
            <div className="w-24 h-8"></div>
           </div>
           <p className="text-center mt-2 text-sm text-gray-500">{status}</p>
         </div>
       </div>
     </main>
   );
}
