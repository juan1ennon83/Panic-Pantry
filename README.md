# Panic Pantry

A real-time, room-code party game for 2–8 players. The server uses only Node.js built-ins.

## Start a kitchen

1. Install Node.js 18 or newer on the computer that will host the game.
2. In this folder, run `node server.js`.
3. Open the `http://localhost:4173` address printed in the terminal.
4. Share the other printed address with friends on the same Wi-Fi. They open that address on their phones, then join with the room code.

The host creates the room and starts the game once at least one other player has joined. The room code is only for joining; players also need the game address. The lobby has a **Copy invite link** button that includes both.

## Let people join from anywhere

This project includes a Render deployment blueprint. Render provides a public HTTPS address and supports the live WebSocket connection the game uses.

1. Put the contents of this folder at the root of a GitHub repository.
2. In Render, connect that repository and create a **Blueprint** from its `render.yaml` file.
3. Once deployment finishes, open the public `onrender.com` address and create a room.
4. Share the invite link from the lobby. Friends can open it anywhere, enter their names, and optionally take a selfie for their tray; the room code is prefilled.

Selfies are resized in the browser and shared with the room. The server keeps them in memory only while the room exists; it does not save them to disk.

The lobby offers an optional selfie step before room entry. The synthesized party loop plays in the lobby and during rounds; the speaker button toggles the music and sound effects. If a mobile browser pauses audio, tap the speaker button to resume it.

The blueprint selects Render’s free web service for a hobby deployment. Free services can sleep after 15 minutes without incoming traffic, take about a minute to wake, and may restart. This game keeps rooms in server memory, so a restart ends active rooms. Keep the deployment to one server instance; multiple instances would need shared room storage. See [Render’s free service limits](https://render.com/docs/free) and [WebSocket guidance](https://render.com/docs/websocket).

## How to play

- Tap a loose item to catch it. Hold one item at a time.
- Touch the held item and swipe toward any tray to toss it. Burgers and milkshakes score only in your tray; beers and burnt burgers subtract points from whichever tray they land in.
- A goofy synthesized party loop plays in the lobby and during rounds, with a squeak while swiping and separate happy/sour sounds on tray hits. Use the speaker button to mute it.
- Burger: +5 · Milkshake: +3 · Beer: −1 · Burnt burger: −2. Scores do not go below zero.
- In the lobby, every connected invited player votes for 3, 4, or 5 minutes; the host does not vote. The most popular length wins; ties between lengths are settled randomly. The host can start after every connected invitee has voted, then a 3-second countdown begins.
- The chosen round length appears beside the scores. Reach 100 points first to win; if nobody does, the highest score when time runs out wins.
- If the score is tied when the timer ends, sudden death starts: the first positive food into your own tray or negative food into an opponent’s tray wins for the scorer/thrower.
- A kitty appears after every 50 regular food spawns and knocks nearby items around.
- Fan gusts, a slippery counter, and extra-bouncy moments change the physics during the match.

## Files

- `server.js` — serves the game and synchronizes rooms, scoring, and physics.
- `public/index.html` — the responsive game and lobby interface.
- `package.json` and `render.yaml` — Node start command and Render deployment settings.
