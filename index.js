// ProJam Ultra - Cloudflare Worker with Durable Objects
export class JamRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // peerId -> { ws, username, udp_ip, udp_port }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    
    // Create a unique ID for this session
    const peerId = crypto.randomUUID();
    
    // Accept and hibernate the socket (better for memory)
    this.ctx.acceptWebSocket(server, [peerId]);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // Handle incoming messages
  async webSocketMessage(ws, message) {
    const [peerId] = this.ctx.getTags(ws);
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join':
          const username = data.username || 'Musician';
          const udp_ip = data.public_ip;
          const udp_port = data.public_port;

          console.log(`User ${username} joining with UDP ${udp_ip}:${udp_port}`);

          // Store the session FIRST
          this.sessions.set(peerId, { ws, username, udp_ip, udp_port });

          // 1. Send existing users to the new joiner
          const existingUsers = [];
          for (const [id, session] of this.sessions) {
            if (id !== peerId) {
              existingUsers.push({
                peerId: id,
                username: session.username,
                udp_ip: session.udp_ip,
                udp_port: session.udp_port
              });
              console.log(`Sending existing user to ${username}: ${session.username} at ${session.udp_ip}:${session.udp_port}`);
            }
          }
          if (existingUsers.length > 0) {
            ws.send(JSON.stringify({ type: 'existing-users', users: existingUsers }));
          }

          // 2. Confirm join to the sender
          ws.send(JSON.stringify({
            type: 'joined',
            peerId: peerId,
            userCount: this.sessions.size
          }));

          // 3. Notify others about new user
          this.broadcast({
            type: 'user-joined',
            peerId: peerId,
            username: username,
            udp_ip: udp_ip,
            udp_port: udp_port
          }, peerId);

          break;

        case 'chat':
          const user = this.sessions.get(peerId);
          this.broadcast({
            type: 'chat',
            username: user ? user.username : "Unknown",
            message: data.message
          });
          break;
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const [peerId] = this.ctx.getTags(ws);
    const session = this.sessions.get(peerId);
    if (session) {
      this.sessions.delete(peerId);
      this.broadcast({
        type: 'user-left',
        peerId: peerId,
        username: session.username
      });
    }
  }

  broadcast(message, excludeId = null) {
    const data = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      if (id !== excludeId) {
        try {
          session.ws.send(data);
        } catch (e) {
          this.sessions.delete(id);
        }
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let roomCode = url.searchParams.get('room') || 'default-room';
    const id = env.JAM_ROOM2.idFromName(roomCode);
    const room = env.JAM_ROOM2.get(id);
    return room.fetch(request);
  }
};