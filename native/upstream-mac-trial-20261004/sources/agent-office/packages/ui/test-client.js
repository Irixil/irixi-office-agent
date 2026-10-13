const Colyseus = require('colyseus.js');
const client = new Colyseus.Client('ws://localhost:3000');
client.joinOrCreate('office').then(room => {
  console.log("Joined!", room.sessionId);
  setTimeout(() => {
    console.log("Map size:", room.state.agents.size);
    console.log("Raw agents:", room.state.toJSON());
    process.exit(0);
  }, 500);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
