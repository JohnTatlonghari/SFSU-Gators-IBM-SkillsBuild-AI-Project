import React from "react";
import Chat, { Bubble, useMessages } from "@chatui/core";
import "@chatui/core/dist/index.css";

export default function App() {
  const { messages, appendMsg } = useMessages([]);

  function handleSend(type, val) {
    if (type === "text" && val.trim()) {
      appendMsg({
        type: "text",
        content: { text: val },
        position: "right",
      });

      // Simulate receiving a message
      setTimeout(() => {
        appendMsg({
          type: "text",
          content: { text: "Hello! I'm your health assistant. How can I help you today?" },
        });
      }, 1000);
    }
  }

  function renderMessageContent(msg) {
    const { type, content } = msg;

    // Render based on message type
    switch (type) {
      case "text":
        return <Bubble content={content.text} />;
      default:
        return null;
    }
  }

  return (
    <Chat
      navbar={{ title: "Health Assistant" }}
      messages={messages}
      renderMessageContent={renderMessageContent}
      onSend={handleSend}
    />
  );
}
