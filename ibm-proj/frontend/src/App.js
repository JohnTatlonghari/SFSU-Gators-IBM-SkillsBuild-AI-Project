import { useState, useEffect, useRef } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Activity, Apple, Moon, Heart, Droplets, Clipboard, X, ChevronDown, Brain } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Use REACT_APP_BACKEND_URL from env when provided, otherwise default to localhost backend.
// This prevents `undefined` being used in URLs when the env var is not set.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8000';
const API = `${BACKEND_URL.replace(/\/+$/, '')}/api`;

const WellnessChat = () => {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [topics, setTopics] = useState([]);
  const [streamingMessage, setStreamingMessage] = useState(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);

  const iconMap = {
    apple: Apple,
    activity: Activity,
    moon: Moon,
    heart: Heart,
    droplet: Droplets,
    clipboard: Clipboard
  };

  useEffect(() => {
    fetchWellnessTopics();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage]);

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  };

  const fetchWellnessTopics = async () => {
    try {
      const response = await fetch(`${API}/wellness-topics`);
      const data = await response.json();
      setTopics(data.topics);
    } catch (error) {
      console.error("Error fetching topics:", error);
    }
  };

  const sendMessage = async (messageText = inputMessage) => {
    if (!messageText.trim()) return;

    const userMessage = { role: "user", content: messageText };
    setMessages(prev => [...prev, userMessage]);
    setInputMessage("");
    setIsLoading(true);

    // Initialize streaming message
    let currentStreamingMsg = {
      role: "assistant",
      thinking: "",
      content: "",
      thinkingComplete: false,
      sources: null,
      webSources: null,
      webSearched: false
    };
    setStreamingMessage(currentStreamingMsg);

    try {
      const response = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: messageText,
          use_web_search: false
        })
      });

      if (!response.ok) {
        throw new Error("Failed to get response");
      }

      const decoder = new TextDecoder();

      // Defensive: some browser extensions can intercept/fork fetch responses and
      // read/clone the body which may make response.body unusable for streaming.
      // Try to get a reader; if that fails, fall back to reading the whole text
      // and parsing it like a completed stream.
      let reader = null;
      try {
        // attempt to clone early (may help some extension behaviors)
        try { response.clone(); } catch (e) { /* ignore clone failures */ }
        reader = response.body.getReader();
      } catch (err) {
        console.warn('Could not get response reader, falling back to text():', err);
        try {
          const full = await response.text();
          // process the entire stream payload as if it was fully received
          const lines = full.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                // reuse the same handlers used in the streaming loop
                if (data.type === 'thinking') {
                  currentStreamingMsg.thinking += data.content;
                  setStreamingMessage({...currentStreamingMsg});
                } else if (data.type === 'thinking_end') {
                  currentStreamingMsg.thinkingComplete = true;
                  setStreamingMessage({...currentStreamingMsg});
                } else if (data.type === 'response') {
                  currentStreamingMsg.content += data.content;
                  setStreamingMessage({...currentStreamingMsg});
                } else if (data.type === 'metadata') {
                  currentStreamingMsg.sources = data.sources;
                  currentStreamingMsg.webSources = data.web_sources;
                  currentStreamingMsg.webSearched = data.web_searched;
                  setStreamingMessage({...currentStreamingMsg});
                } else if (data.type === 'done') {
                  setMessages(prev => [...prev, {
                    role: "assistant",
                    content: currentStreamingMsg.content,
                    thinking: currentStreamingMsg.thinking || null,
                    sources: currentStreamingMsg.sources,
                    webSources: currentStreamingMsg.webSources,
                    webSearched: currentStreamingMsg.webSearched
                  }]);
                  setStreamingMessage(null);
                }
              } catch (e) {
                console.error('Error parsing stream (fallback) data:', e, 'Line:', line);
              }
            }
          }
        } catch (e) {
          console.error('Fallback text() read failed:', e);
          throw e;
        }
        // finished fallback handling
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('Stream reader done');
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              console.log('Stream event:', data.type, data.content?.substring(0, 20));

              if (data.type === 'thinking_start') {
                // Thinking started
              } else if (data.type === 'thinking') {
                currentStreamingMsg.thinking += data.content;
                setStreamingMessage({...currentStreamingMsg});
              } else if (data.type === 'thinking_end') {
                currentStreamingMsg.thinkingComplete = true;
                setStreamingMessage({...currentStreamingMsg});
              } else if (data.type === 'response_start') {
                // Response started
                console.log('Response streaming started');
              } else if (data.type === 'response') {
                currentStreamingMsg.content += data.content;
                setStreamingMessage({...currentStreamingMsg});
              } else if (data.type === 'response_end') {
                // Response ended
                console.log('Response complete, content length:', currentStreamingMsg.content.length);
              } else if (data.type === 'metadata') {
                currentStreamingMsg.sources = data.sources;
                currentStreamingMsg.webSources = data.web_sources;
                currentStreamingMsg.webSearched = data.web_searched;
                setStreamingMessage({...currentStreamingMsg});
              } else if (data.type === 'done') {
                // Finalize message
                console.log('Finalizing message with content length:', currentStreamingMsg.content.length);
                setMessages(prev => [...prev, {
                  role: "assistant",
                  content: currentStreamingMsg.content,
                  thinking: currentStreamingMsg.thinking || null,
                  sources: currentStreamingMsg.sources,
                  webSources: currentStreamingMsg.webSources,
                  webSearched: currentStreamingMsg.webSearched
                }]);
                setStreamingMessage(null);
              }
            } catch (e) {
              console.error('Error parsing stream data:', e, 'Line:', line);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error sending message:", error);
      toast.error("Unable to get response. Please try again.");
      setStreamingMessage(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTopicClick = (topic) => {
    const topicQuestions = {
      nutrition: "What are some general healthy eating guidelines?",
      exercise: "How much exercise should I get weekly?",
      sleep: "What are good sleep hygiene practices?",
      stress: "What are some healthy ways to manage stress?",
      hydration: "How much water should I drink daily?",
      checkup: "How often should I get routine health checkups?"
    };
    sendMessage(topicQuestions[topic.id]);
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setStreamingMessage(null);
    toast.success("Conversation cleared");
  };

  const renderMessage = (msg, idx) => (
    <div
      key={idx}
      className={`message-wrapper ${msg.role}`}
      data-testid={`message-${msg.role}-${idx}`}
    >
      <div className="message-bubble">
        <div className="message-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {msg.content}
          </ReactMarkdown>
        </div>
        
        {msg.thinking && (
          <Collapsible className="thinking-section">
            <CollapsibleTrigger className="thinking-trigger" data-testid={`thinking-trigger-${idx}`}>
              <div className="thinking-header">
                <Brain size={16} />
                <span>View Thinking Process</span>
              </div>
              <ChevronDown size={16} className="chevron" />
            </CollapsibleTrigger>
            <CollapsibleContent className="thinking-content">
              <div className="thinking-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.thinking}
                </ReactMarkdown>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {msg.sources && msg.sources.length > 0 && (
          <div className="sources-section">
            <div className="sources-header">
              <span className="sources-label">Trusted Sources</span>
            </div>
            <div className="sources-list">
              {msg.sources.map((source, i) => (
                <Badge key={i} variant="secondary" className="source-badge">
                  {source}
                </Badge>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );

  return (
    <div className="wellness-app">
      <div className="wellness-container">
        <div className="wellness-header">
          <div className="header-left">
            <div className="logo-circle">
              <Heart className="logo-icon" size={24} />
            </div>
            <div className="header-text">
              <h1 data-testid="app-title">Wellness Guide</h1>
              <p className="tagline">Your trusted health companion</p>
            </div>
          </div>
          <div className="header-actions">
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearChat}
                className="clear-button"
                data-testid="clear-chat-btn"
              >
                <X size={16} />
                Clear
              </Button>
            )}
          </div>
        </div>

        {messages.length === 0 && !streamingMessage && (
          <div className="welcome-section">
            <div className="welcome-content">
              <div className="welcome-icon-group">
                <div className="floating-icon icon-1">
                  <Activity size={28} />
                </div>
                <div className="floating-icon icon-2">
                  <Apple size={28} />
                </div>
                <div className="floating-icon icon-3">
                  <Moon size={28} />
                </div>
              </div>
              <h2>Welcome to Your Wellness Journey</h2>
              <p className="welcome-description">
                Get personalized guidance on nutrition, exercise, sleep, and more.
                All advice based on trusted health organizations.
              </p>
              <div className="topics-grid">
                {topics.map((topic) => {
                  const Icon = iconMap[topic.icon];
                  return (
                    <button
                      key={topic.id}
                      className="topic-card"
                      onClick={() => handleTopicClick(topic)}
                      data-testid={`topic-${topic.id}`}
                    >
                      <Icon size={24} />
                      <span>{topic.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="messages-container" ref={messagesContainerRef} data-testid="messages-container">
          {messages.map((msg, idx) => renderMessage(msg, idx))}
          
          {streamingMessage && (
            <div className="message-wrapper assistant streaming" data-testid="streaming-message">
              <div className="message-bubble">
                {streamingMessage.thinking && (
                  <div className="thinking-stream">
                    <div className="thinking-stream-header">
                      <Brain size={16} className="pulse" />
                      <span>Thinking...</span>
                    </div>
                    <div className="thinking-stream-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingMessage.thinking}
                      </ReactMarkdown>
                      {!streamingMessage.thinkingComplete && <span className="cursor">|</span>}
                    </div>
                  </div>
                )}
                
                {streamingMessage.content && (
                  <div className="response-stream">
                    <div className="message-text">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingMessage.content}
                      </ReactMarkdown>
                      <span className="cursor">|</span>
                    </div>
                  </div>
                )}

                {!streamingMessage.thinking && !streamingMessage.content && (
                  <div className="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                )}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-section">
          <div className="input-wrapper">
            <Input
              type="text"
              placeholder="Ask about nutrition, exercise, sleep, or wellness..."
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={isLoading}
              className="wellness-input"
              data-testid="message-input"
            />
            <Button
              onClick={() => sendMessage()}
              disabled={isLoading || !inputMessage.trim()}
              className="send-button"
              data-testid="send-button"
            >
              <Send size={18} />
            </Button>
          </div>
          <p className="disclaimer">
            This is general wellness guidance only. For medical concerns, consult a healthcare professional.
          </p>
        </div>
      </div>
      <Toaster position="top-center" richColors />
    </div>
  );
};

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<WellnessChat />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

export default App;