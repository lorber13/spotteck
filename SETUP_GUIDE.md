# Spotteck 2.0 — installazione e sviluppo

## Requisiti

Mac Apple Silicon con macOS 14.2 o successivo e un account **Spotify Premium** (anche Family, Duo o Student). Gli account Free non sono supportati: Spotteck lo segnala nelle Impostazioni.

Spotteck riproduce l’audio da solo, come dispositivo Spotify Connect. Non serve Spotify Desktop, nessun motore esterno, nessuna chiave personale e nessun Client ID.

## Installare

Apri il DMG e trascina Spotteck in Applicazioni. Il pacchetto locale non è notarizzato Apple: al primo avvio usa clic destro → Apri.

Dati e playlist aggiunte restano in `~/Library/Application Support/com.braun.spotteck`; aggiornare l’app non li cancella. Al primo avvio le playlist aggiunte con Spotteck 1.x vengono importate automaticamente.

## Account e riproduzione

1. Apri le Impostazioni e premi **Accedi**. Il browser mostra la pagina di accesso di Spotify; al termine torna a Spotteck.
2. L’accesso riutilizzabile è salvato nel Portachiavi di macOS: ai riavvii successivi Spotteck si ricollega da solo.
3. La griglia mostra le playlist della tua libreria Spotify. Con **+** puoi aggiungere altre playlist incollando il link (Spotify: Condividi → Copia link alla playlist).
4. Spotteck compare come dispositivo Spotify Connect anche nell’app Spotify del telefono: da lì puoi spostare la riproduzione sul Mac. Se un altro dispositivo sta suonando, Play su Spotteck porta la riproduzione qui.
5. L’uscita è sempre quella predefinita di macOS. Lo slider controlla il volume di Spotteck. I tasti multimediali e il Centro di controllo funzionano tramite Now Playing di macOS.

**Disconnetti** ferma la riproduzione e cancella l’accesso dal Portachiavi; le playlist aggiunte con + restano.

## Visualizzatori

Spotteck analizza direttamente l’audio che sta riproducendo. Non chiede permessi di registrazione, non apre il microfono e non salva nulla. Spettro, onda e i due VU (RMS e picchi stereo separati) seguono il segnale reale; in pausa i visualizzatori restano fermi.

## Sviluppo

Richiede Rust (stable), Node.js/npm e Xcode Command Line Tools.

```
npm ci
npm start            # tauri dev
npm test             # cargo test --workspace + node --test
npm run check:ui     # prova isolata dell’interfaccia in Chromium (Playwright)
npm run pack         # Spotteck.app
npm run dist         # .app + .dmg
```

Il codice Rust è diviso in:

- `crates/spotteck-core`: stato del lettore, disponibilità, playlist aggiunte, analisi audio. Nessuna dipendenza di sistema: i test girano su qualsiasi piattaforma.
- `crates/spotteck-spotify`: collegamento a Spotify tramite librespot (accesso, Spotify Connect, libreria, copia dell’audio per i visualizzatori).
- `src-tauri`: l’app Tauri (finestra, comandi, eventi, Portachiavi, Now Playing).
- `ui`: l’interfaccia HTML/CSS/JS.

librespot è una libreria open source non ufficiale: se Spotify cambia il protocollo, può servire aggiornarla.
