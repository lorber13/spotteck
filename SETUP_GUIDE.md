# SPOTTECK — Guida Ufficiale di Configurazione & Blueprint Tecnico
> **Doppio formato:**  
> 👤 **Parte 1:** Guida Semplice per Utenti Umani (non tecnici)  
> 🤖 **Parte 2:** Specifiche Tecniche & Prompt Operativo per Agenti AI  

---

# 👤 PARTE 1: GUIDA PER ESSERI UMANI (FACILE E PRATICA)

### Cos'è Spotteck?
**Spotteck** è un lettore e telecomando hardware virtuale per Mac, ispirato al design industriale minimalista della **Braun** (Dieter Rams). 
Ti permette di visualizzare e ascoltare le tue playlist preferite di Spotify godendoti strumenti analogici animati a 60 FPS:
* 🎛️ **Oscilloscopio a tubo catodico CRT**
* 📼 **Cassetta a nastro** con bobine rotanti che girano a ritmo reale
* 📻 **Doppio VU Meter analogico** con aghi balistici e spia di picco
* 💿 **Giradischi in vinile** con etichetta dell'album
* 🔮 **Aether Morph (Fluido bio-organico)** in 3 varianti estetiche ipnotiche

---

## 🚀 Come si Installa (in 2 Minuti)

### Metodo Rapido (Se hai già il file DMG)
1. Apri la cartella `dist/` nel progetto.
2. Fai doppio clic sul file `Spotteck-1.0.0-arm64.dmg`.
3. Trascina l'icona di **Spotteck** nella cartella **Applicazioni** del tuo Mac.
4. Avvia **Spotteck** dal Launchpad o da Applicazioni.

### Metodo da Codice (Se vuoi avviarlo dal terminale)
1. Assicurati di avere installato **Node.js** sul tuo Mac.
2. Apri il Terminale dentro la cartella del progetto (`V`).
3. Installa i moduli necessari digitando:
   ```bash
   npm install
   ```
4. Avvia l'applicazione digitando:
   ```bash
   npm start
   ```

---

## 🎵 Come Funziona l'Integrazione con Spotify
Spotteck lavora insieme all'app ufficiale di **Spotify Desktop**:
1. **Zero finestre fastidiose:** Quando premi play o cambi playlist da Spotteck, Spotify suona **completamente in background**. Non si apre a schermo intero, non ti ruba il focus e non cambia desktop virtuale.
2. **Accedi con il tuo account:** Spotify deve essere semplicemente aperto sul tuo Mac (anche ridotto a icona o nascosto). Se possiedi un account Spotify Premium, Spotteck controllerà la musica direttamente tramite **Spotify Connect**.

---

## 🕹️ Come si Usa Spotteck (Comandi e Trucchi)

| Azione | Come si fa |
| :--- | :--- |
| **Cambiare Playlist** | **Clic sinistro** su una copertina nel pannello di destra. La playlist in riproduzione si illuminerà con un **sottile contorno arancione**. |
| **Vedere e Scegliere i Singoli Brani** | **Clic destro** su una playlist per aprire la lista brani a cassetto. Il brano attualmente in riproduzione è evidenziato in arancione. |
| **Cambiare Brano** | Premi i tasti freccia **Avanti / Indietro** nell'interfaccia oppure le **frecce della tastiera** (`←` e `→`). La selezione nel cassetto scorrerà automaticamente! |
| **Play / Pausa** | Clic sul tasto arancione centrale oppure premi la **Barra Spaziatrice**. |
| **Regolare il Volume** | Trascina la levetta del volume orizzontale in basso a destra. |
| **Cambiare Strumento (VU Meter, Vinile, ecc.)** | Clicca direttamente sul quadrante circolare per passare allo strumento successivo. |
| **Aether Morph a Tutto Schermo** | Clicca il pulsante con le freccette in alto a destra. Tenendo premuto il tasto **Option (Alt)** della tastiera comparirà un pannello di controllo segreto per regolare la biomassa e la vibrazione del fluido! |
| **Aggiungere una nuova Playlist** | Clicca sul riquadro `+` in basso a destra e incolla il link della playlist preso da Spotify (Condividi → Copia link). |

---

## ⚠️ Risoluzione dei Problemi Comuni

* **La musica non parte al primo clic:**  
  Assicurati che l'app di Spotify sia installata sul Mac e che tu abbia effettuato l'accesso almeno una volta.
* **macOS mostra un avviso di sicurezza ("Spotteck vorrebbe controllare Spotify"):**  
  Clicca sempre su **"OK"**. Questo permesso permette a Spotteck di comunicare con Spotify in background senza mai intralciarti.
* **Voglio disinstallare l'app:**  
  Basta trascinare l'icona di Spotteck dal cestino delle Applicazioni. I tuoi dati salvati restano al sicuro in `~/Library/Application Support/Spotteck/`.

---
---

# 🤖 PARTE 2: BLUEPRINT PER AGENTI AI & SVILUPPATORI SENIOR

Questo capitolo contiene le **specifiche tecniche complete, vincoli architetturali e linee guida di codice** per qualsiasi agente AI incaricato di mantenere, aggiornare o ricostruire Spotteck.

```
+-------------------------------------------------------------------------+
|                  SPOTTECK KNOWLEDGE GRAPH & ARCHITECTURE                |
+-------------------------------------------------------------------------+
| [Electron Main (main.js)]                                               |
|    |-- Window Lifecycle & Bounds Persist (window-bounds.json)           |
|    |-- Global Media Shortcuts (F7, F8, F9 via globalShortcut)           |
|    |-- PlaylistsStore (playlists-store.js) <-> playlists.json           |
|    +-- SpotifyController (spotify-controller.js)                        |
|           |-- Tier 1: Spotify Connect Web API (PUT /v1/me/player/play)  |
|           |-- Tier 2: macOS AppleScript (osascript -e) [Fallback]       |
|           +-- Window Suppression Engine (AXFullScreen: false, hide)     |
|                                                                         |
| [IPC ContextBridge (preload.js)]                                        |
|    +-- window.spotteck (Strictly Sandboxed, 0 Node internals exposed)  |
|                                                                         |
| [Electron Renderer (app.js + visualizers.js)]                           |
|    |-- 60 FPS Telemetry & Math Audio Synthesis Loop (requestAnimationFrame)|
|    |-- Selective Canvas Rendering (Only active instrument is painted)   |
|    |-- Reactive Playlist Active State (Border #FF5924 + Drawer Sync)    |
|    +-- Dieter Rams / Braun Industrial Design (styles.css)               |
+-------------------------------------------------------------------------+
```

---

## 1. Regole Tassative del Progetto (System Invariants)
1. **REGOLA ZERO-VIOLA (STRICTLY NO PURPLE/VIOLET):**
   * È **tassativamente vietato** utilizzare tonalità viola, indaco, porpora o magenta (`#8...`, `#9...`, `#A...`, `rgb(128, 0, 128)`, ecc.) in qualsiasi elemento UI, icona, animazione, sfumatura o preset canvas.
   * La palette ammessa è rigorosamente **Braun Industrial**: nero grafite anodizzato (`#141413`), metallo caldo (`#1C1B1A`), bianco latte (`#F0EFEA`), grigio tenue e **Arancione Braun puro** (`#FF5924`, `#FF6B3D`) per accenti e selezione.
2. **PROTOCOLLO PONYTAIL (MINIMALISMO & ANTI-OVERENGINEERING):**
   * Non aggiungere librerie esterne pesanti se il problema si risolve con API native del browser o di Node.js (YAGNI).
   * Nessun framework front-end pesante (niente React/Vue): il DOM è gestito in **Vanilla JavaScript** superleggero a 60/120 FPS.
3. **SICUREZZA ELECTRON:**
   * `contextIsolation: true`
   * `nodeIntegration: false`
   * Nessuna esposizione diretta di `ipcRenderer` o `child_process` nel frontend.

---

## 2. Struttura dei File e Responsabilità

```
/Users/marco/Desktop/ToDO/__APP BUILD/V/
├── package.json               # Configurazione Electron & script build (pack, dist)
├── src/
│   ├── main.js               # Entry point Electron, gestione finestre, scorciatoie globali
│   ├── preload.js            # ContextBridge sicuro (window.spotteck)
│   ├── spotify-controller.js # Controller di riproduzione ibrido (Connect + AppleScript)
│   ├── playlists-store.js    # Store locale delle playlist e parser metadati
│   ├── visualizers.js        # Motore canvas ad alte prestazioni per tutti gli strumenti
│   ├── app.js                # Controller UI, loop di rendering 60 FPS, gestione eventi
│   ├── index.html            # Struttura del quadrante fisico e bays Braun
│   └── styles.css            # Stili anodizzati, micro-crafting e design tokens
└── dist/                     # Pacchetti finali compilati (.app, .dmg, .zip)
```

---

## 3. Logica del Backend Audio (`spotify-controller.js`)

Per evitare che Spotify Desktop si apra a schermo intero o rubi il focus quando l'utente cambia playlist, l'agente AI deve adottare un'architettura **a due livelli (Hybrid Connect/AppleScript)**:

### Livello 1: Spotify Connect (Web API)
* **Endpoint Play:** `PUT https://api.spotify.com/v1/me/player/play`
  * Playlist intera: `{ "context_uri": playlistUri }`
  * Brano specifico: `{ "context_uri": playlistUri, "offset": { "uri": trackUri } }`
* **Vantaggio:** Il comando raggiunge il demone audio tramite cloud socket. macOS **non attiva la finestra**, non cambia Space e non mostra pop-up.
* **Gestione Credenziali:** Legge e decifra la sessione autenticata (es. tramite PBKDF2 + AES-256-GCM con salt dell'host o token OAuth) e rinnova automaticamente l'access token prima della scadenza.

### Livello 2: AppleScript (Fallback Locale)
Se la Web API è offline o non autenticata, il controller ripiega su AppleScript nativo macOS:
```applescript
tell application "Spotify"
  play track myUri in context myContext
end tell
tell application "System Events"
  try
    tell process "Spotify"
      set value of attribute "AXFullScreen" of window 1 to false
    end tell
    set visible of (every process whose bundle identifier is "com.spotify.client") to false
  end try
end tell
```
* **Prevenzione Focus:** Forza sempre `AXFullScreen = false` e `visible = false` per evitare che la finestra di Spotify prenda il controllo del monitor.

---

## 4. Frontend & Render Loop 60 FPS (`app.js` & `visualizers.js`)

1. **Sintesi Telemetrica Audio:**
   * Quando Spotify suona in background, il motore audio analizza il tempo (`curPos`) e sintetizza un inviluppo acustico a 124 BPM (transienti per cassa, rullante sul backbeat e charleston).
   * L'interpolazione temporale usa `performance.now()`, garantendo continuità perfetta indipendentemente dalla frequenza del polling IPC.
2. **Disegno Selettivo:**
   * Viene disegnato ad ogni frame **soltanto lo strumento visibile** (`if (activeId === 'vu') drawVU(...)`). Gli strumenti nascosti non consumano cicli di rendering.
3. **Drawer & Selezione Playlist:**
   * La playlist attiva possiede la classe CSS `.tile.active` (`border-color: #FF5924`).
   * Il cassetto laterale traccia la canzone corrente applicando `.track-row.current` e invoca `scrollIntoView({ block: 'nearest', behavior: 'smooth' })`.

---

## 5. Comandi di Build e Packaging

Tutti i comandi devono essere eseguiti all'interno della directory root del progetto:

```bash
# 1. Verifica sintattica di tutti i file JS
node -c src/main.js
node -c src/preload.js
node -c src/spotify-controller.js
node -c src/playlists-store.js
node -c src/visualizers.js
node -c src/app.js

# 2. Esecuzione in modalità sviluppo
npm start

# 3. Compilazione pacchetto standalone (.app nella cartella dist/mac-arm64)
npm run pack

# 4. Creazione installer di rilascio (.dmg e .zip)
npm run dist

# 5. Installazione diretta nella cartella /Applications del Mac
killall Spotteck 2>/dev/null; sleep 0.5
rm -rf /Applications/Spotteck.app
cp -R dist/mac-arm64/Spotteck.app /Applications/Spotteck.app
open -a /Applications/Spotteck.app
```

---

## 6. Checklist di Verifica per l'Agente AI
Prima di considerare conclusa qualsiasi modifica, l'agente deve verificare:
- [ ] Nessuna occorrenza di colori viola/porpora nel codice CSS o JS.
- [ ] `node -c` passa con codice 0 su tutti i file in `src/`.
- [ ] Il cambio di playlist da Spotteck non porta in primo piano Spotify Desktop.
- [ ] Le frecce della tastiera (`←` e `→`) avanzano la canzone e aggiornano la selezione nel cassetto tracce.
- [ ] La playlist in riproduzione ha il riquadro di contorno arancione sottile.
- [ ] I rotori della cassetta e il piatto del vinile si muovono solo quando la musica è in riproduzione.
- [ ] Nessun file al di fuori della cartella del progetto è stato modificato o rimosso.
