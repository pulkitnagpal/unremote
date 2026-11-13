# The launch film

```bash
cd film && npm install          # opentype.js, for the logo's wordmark
node film/logo.mjs              # docs/img/logo.svg, logo.png, logo-mark.svg, logo-mark.png
node film/stage.mjs             # dist/film: the stage, data.js and the phone recordings as image sequences
node film/render.mjs video dist/unremote-1.0.mp4 16
FILM_NOCAPTIONS=1 FILM_NAME=unremote-1.0-poster.png node film/render.mjs stills 28.3 dist
node film/boards.mjs            # dist/boards/index.html (the design boards) and media/boards/*.png
```

The film is one 1920×1080 HTML stage (`film.html`, `film.js`, `film.css`). Everything on it is a function of the time, so headless Brave steps it frame by frame over the DevTools protocol (`cdp.mjs`) and the frames are piped to ffmpeg: H.264 High, yuv420p, BT.709, 60 fps, no audio. The design boards mount the same stage seven times, stopped at key moments, so the boards and the film can't drift apart.

What it draws from, all real:

- `media/raw/manual-booking.mp4` and `agent-scan.mp4`, screen recordings of ShowTime. `timing.json` maps scene time to video time, and lists the taps and screen changes found in the manual recording (43 taps counting keys, 9 screens).
- The latest `runs/showtime-*` run: the agent's 13 actions and reasons, which action called which endpoint, and the request count.
- `media/raw/claude-booking.txt`: Claude Code's reply, shown as written; the tool calls match `claude-tool-calls.txt`. `showtime-tools.json`: the 7 tools.
- The latest `runs/wikipedia-*` run (steps, tools) and `media/raw/claude-wikipedia.txt` (two lines of Claude's answer). The Wikipedia phone frame is the first second of `manual-booking.mp4`, which shows the same featured article.

The agent recording stops at 179 s (screenrecord's limit), just after A1 is selected. After the HOLD tap the film cuts to the Payment screen from the first seconds of the same recording.

Stills for checking a change: `node film/render.mjs stills 12,40` (written to `dist/film/stills`).

| s | Beat | Caption |
|---|---|---|
| 0–13.6 | **By hand.** The manual recording, sped up, with a tally of taps, screens and time. Then the screen fades and the API calls under the taps show. | Booking two movie tickets, by hand. · 9 screens. 43 taps, counting every key. · Under every tap, there's an API call. |
| 13.6–29 | **The agent explores.** `unremote learn showtime`, goals from the store listing, the agent's steps and reasons over the real recording. Endpoints land on the map as each tap calls them; the value chips draw on. | `unremote learn`: the agent explores the app by itself. · A proxy captures every HTTPS call it makes. · Unremote maps how each value flows to the next call. |
| 29–34.8 | **Tools.** The 7 tools Claude designed, then the generated server. | Claude turns the map into tools and an MCP server. |
| 34.8–52.6 | **Just ask.** The prompt, six tool calls, Claude's real reply. The cheaper theatre and C4–C5 are circled; the payment link is circled and the camera leans in. | Now just ask. · Claude compares theatres, finds two seats together, holds them. · It stops at the payment link. You pay. |
| 52.6–57.2 | **A real app.** The Wikipedia app, learned the same way: 27 agent steps, 10 tools, each checked live, and Claude's answers from them, verbatim. | And on a real app: Wikipedia, learned the same way. |
| 57.2–63.6 | **End card.** Logo, "Any Android app → an MCP server.", "Scanned once, by the agent itself.", the repo, "Open source". | |
