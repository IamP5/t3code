# Fluxo de sessão: Web → Server → Codex CLI

Diagrama sequence (Mermaid) mostrando a interação fim-a-fim entre o cliente web, servidor, adapter e o binário Codex App Server.

```mermaid
sequenceDiagram
    participant Web as Web Client (Browser)
    participant WS as WebSocket Server (ws.ts)
    participant Orc as Orchestration / Command Dispatcher
    participant Adapter as CodexAdapter
    participant Runtime as CodexSessionRuntime
    participant CLI as Codex App Server (binary)

    Web->>WS: RPC: thread.turn.start (via WS RPC)
    WS->>Orc: normalizeDispatchCommand -> orchestration.dispatch
    Orc->>Adapter: Request provider: thread.turn.start
    Adapter->>Runtime: make/sendTurn(...) / start session
    Runtime->>CLI: JSON-RPC over stdio: "turn/start" (via effect-codex-app-server client)
    CLI-->>Runtime: Response + asynchronous notifications
    Runtime-->>Adapter: emit ProviderEvent (notification/request)
    Adapter->>Orc: dispatch provider events -> update read models
    Orc->>WS: push orchestration.domainEvent -> Web
    WS-->>Web: Event / notifications

    alt Approval required (example)
      CLI->>Runtime: serverRequest: item/commandExecution/requestApproval
      Runtime-->>WS: emit "request" event (UI shows approval)
      Web->>WS: UI responds with approval decision
      WS->>Adapter: user decision -> adapter.respondToRequest
      Adapter->>Runtime: respondToRequest(requestId, decision)
      Runtime->>CLI: return decision in RPC response
    end

    alt Errors & process logs
      CLI-->>Runtime: stderr lines
      Runtime-->>Adapter: emit session/process/stderr events
      CLI-->>Runtime: exit
      Runtime-->>Adapter: emit session/closed (status update)
    end
```

> Arquivo gerado: apps/server/codex_session_flow.md
