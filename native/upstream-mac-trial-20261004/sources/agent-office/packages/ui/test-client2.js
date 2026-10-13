const Colyseus = require('colyseus.js');
const client = new Colyseus.Client('ws://localhost:3000');
client.joinOrCreate('office').then(room => {
  console.log("Map size:", room.state.agents.size);
  process.exit(0);
});
