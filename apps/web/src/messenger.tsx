import { useEffect, useState } from "react";
import { MessengerApp } from "@j-messenger/client-react";
import { createGroupwareMessengerClient } from "@j-messenger/client-core";
import type { ClientSocket } from "@j-messenger/client-core";
import type { MeResponse } from "@j-groupware/contracts";
import { Feedback } from "./common.js";

function socketFactory(path: string): ClientSocket {
  const url = new URL(path, location.href);
  if (
    url.protocol !== "wss:" ||
    url.host !== location.host ||
    url.pathname !== "/api/messenger/ws" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid messenger transport");
  const socket = new WebSocket(url);
  const messages = new Set<(value: unknown) => void>();
  const closes = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data.length > 1048576) {
      socket.close();
      return;
    }
    try {
      const value: unknown = JSON.parse(event.data);
      for (const handler of messages) handler(value);
    } catch {
      socket.close();
    }
  });
  socket.addEventListener("close", () => {
    for (const handler of closes) handler();
  });
  return {
    send: (value) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(value));
    },
    close: () => socket.close(),
    onMessage: (handler) => {
      messages.add(handler);
      return () => messages.delete(handler);
    },
    onClose: (handler) => {
      closes.add(handler);
      return () => closes.delete(handler);
    },
  };
}

export function Messenger({
  me,
  onLogout,
  onExpired,
}: {
  me: MeResponse;
  onLogout: () => Promise<void>;
  onExpired: () => void;
}) {
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [client] = useState(() => {
    const transport = createGroupwareMessengerClient({
      origin: location.origin,
      csrfToken: () => me.csrfToken,
      socketFactory,
      visibilitySource: document,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 401) onExpired();
        return response;
      },
    });
    return {
      ...transport,
      // The customer session has a fixed tenant; no independent service login is offered.
      listServers: async () => {
        const user = transport.getSnapshot().user;
        return user ? [{ id: user.serverId, name: me.tenant }] : [];
      },
      logout: async () => {
        await onLogout();
        return transport.logout(false);
      },
    };
  });
  useEffect(() => {
    let active = true;
    void client
      .resumeSession()
      .then((user) => {
        if (active) {
          if (user) setReady(true);
          else setError("메신저 사용자 정보를 확인하지 못했습니다.");
        }
      })
      .catch(() => {
        if (active)
          setError(
            "메신저 연결을 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요.",
          );
      });
    return () => {
      active = false;
      client.dispose();
    };
  }, [client]);
  return (
    <>
      <h1>메신저</h1>
      <Feedback error={error} loading={!ready && !error} />
      {ready ? (
        <div className="messenger-embed">
          <MessengerApp client={client} />
        </div>
      ) : null}
    </>
  );
}
