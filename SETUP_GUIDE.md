# Spotteck — Guida & Blueprint Tecnico
> 👤 **Parte 1:** Guida per l'utente  
> 🤖 **Parte 2:** Specifiche tecniche per agenti AI  

---

# 👤 PARTE 1: GUIDA UTENTE

### Cos'è Spotteck?
Una nuova interfaccia per Spotify più bella, essenziale ed elegante.  
Elimina le distrazioni dell'app ufficiale e racchiude Spotify in un telecomando compatto con visualizzatori analogici (oscilloscopio, cassetta, VU meter, vinile, fluido Aether).

---

## 🚀 Installazione

### Tramite DMG (consigliato)
1. Scarica e apri il file `.dmg` dalla cartella `dist/` o dalle Release.
2. Trascina **Spotteck** nella cartella **Applicazioni**.
3. Avvia Spotteck.

### Da terminale
```bash
npm install
npm start
```

---

## 🎵 Come funziona con Spotify
1. Spotify deve essere aperto sul Mac (anche ridotto a icona o nascosto).
2. Spotteck controlla la riproduzione in background: Spotify non si apre a schermo intero e non ruba il focus.

---

## 🕹️ Comandi

| Azione | Comando |
| :--- | :--- |
| **Riprodurre una playlist** | Clic sinistro sulla copertina (contorno arancione attivo). |
| **Scegliere i brani** | Clic destro sulla playlist per aprire la lista. |
| **Cambiare brano** | Frecce tastiera (`←` / `→`) o frecce a schermo. |
| **Play / Pausa** | Barra spaziatrice o tasto centrale. |
| **Regolare il volume** | Slider in basso a destra. |
| **Cambiare visualizzatore** | Clic sul quadrante circolare. |
| **Aggiungere playlist** | Tasto `+` in basso a destra (incolla link Spotify). |

---

## ⚠️ Domande frequenti

* **La musica non parte:** apri l'app Spotify ed effettua l'accesso.
* **Richiesta permessi macOS ("Spotteck vorrebbe controllare Spotify"):** premi **OK**.

---
---

# 🤖 PARTE 2: SPECIFICHE TECNICHE PER AGENTI AI

```
+-------------------------------------------------------------------------+
|                  SPOTTECK KNOWLEDGE GRAPH & ARCHITECTURE                |
+-------------------------------------------------------------------------+
| [Electron Main (main.js)]                                               |
|    |-- Lifecycle & Bounds Persist (window-bounds.json)                  |
|    |-- Global Media Shortcuts (F7, F8, F9 via globalShortcut)           |
|    |-- PlaylistsStore (playlists-store.js) <-> playlists.json           |
|    +-- SpotifyController (spotify-controller.js)                        |
|           |-- Tier 1: Spotify Connect Web API (PUT /v1/me/player/play)  |
|           |-- Tier 2: macOS AppleScript (osascript -e) [Fallback]       |
|           +-- Window Suppression Engine (AXFullScreen: false, hide)     |
|                                                                         |
| [IPC ContextBridge (preload.js)]                                        |
|    +-- window.spotteck (Sandboxed, 0 Node internals exposed)            |
|                                                                         |
| [Electron Renderer (app.js + visualizers.js)]                           |
|    |-- Audio Telemetry Loop (requestAnimationFrame)                     |
|    |-- Selective Canvas Rendering (Only active instrument is painted)   |
|    |-- Reactive Playlist Active State (Border #FF5924 + Drawer Sync)    |
|    +-- Minimal Industrial Design (styles.css)                           |
+-------------------------------------------------------------------------+
```

---

## 1. Regole di Progetto

1. **DIVIETO ASSOLUTO DEL VIOLA (NO PURPLE/VIOLET):**
   * Vietata qualsiasi tonalità viola, indaco, porpora o magenta (`#8...`, `#9...`, `#A...`, `rgb(128, 0, 128)`, ecc.).
   * Palette ammessa: nero grafite (`#141413`), metallo scuro (`#1C1B1A`), bianco latte (`#F0EFEA`), grigio e arancione (`#FF5924`, `#FF6B3D`) per accenti e selezione.
2. **MINIMALISMO & ANTI-OVERENGINEERING:**
   * Nessun framework front-end: solo Vanilla JavaScript leggero.
   * Nessuna ridondanza nel codice o nei testi.
3. **SICUREZZA ELECTRON:**
   * `contextIsolation: true`, `nodeIntegration: false`.
   * Nessun accesso diretto a Node nel renderer.

---

## 2. Struttura dei File

```
src/
├── main.js               # Entry point Electron, finestre, scorciatoie globali
├── preload.js            # ContextBridge sicuro (window.spotteck)
├── spotify-controller.js # Controller riproduzione ibrido (Connect + AppleScript)
├── playlists-store.js    # Store locale playlist e parser metadati
├── visualizers.js        # Motore canvas per tutti gli strumenti
├── app.js                # Controller UI, loop telemetria audio, eventi
├── index.html            # Struttura del layout
└── styles.css            # Stili e design tokens
```

---

## 3. Backend Audio (`spotify-controller.js`)

Architettura a due livelli per impedire l'apertura a schermo intero di Spotify:

1. **Livello 1: Spotify Connect (Web API):**
   * Endpoint Play: `PUT https://api.spotify.com/v1/me/player/play`
   * Il comando passa via rete: la finestra di Spotify non si apre e non cambia Space.
   * Rinnovo automatico dell'access token prima della scadenza.
2. **Livello 2: AppleScript (Fallback):**
   * In caso di offline, usa AppleScript con soppressione finestra:
   ```applescript
   tell application "Spotify" to play track myUri in context myContext
   tell application "System Events"
     try
       tell process "Spotify" to set value of attribute "AXFullScreen" of window 1 to false
       set visible of (every process whose bundle identifier is "com.spotify.client") to false
     end try
   end tell
   ```

---

## 4. Frontend & Render Loop (`app.js` & `visualizers.js`)

1. **Disegno selettivo:** viene ridisegnato solo lo strumento attivo (`scope`, `cassette`, `vu`, `vinyl`, `aetherBlob`).
2. **Sincronizzazione drawer:** la traccia in riproduzione riceve `.track-row.current` e invoca `scrollIntoView`.
3. **Stato playlist attiva:** la playlist corrente ha `.tile.active` (`border-color: #FF5924`).

---

## 5. Comandi di Build

```bash
# Validazione sintattica
node -c src/main.js && node -c src/preload.js && node -c src/spotify-controller.js && node -c src/playlists-store.js && node -c src/visualizers.js && node -c src/app.js

# Avvio locale
npm start

# Compilazione pacchetto .app
npm run pack

# Creazione installer .dmg
npm run dist
```
