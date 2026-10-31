# Spotteck 2.0 — installazione e sviluppo

## Requisiti

Un account **Spotify Premium** (anche Family, Duo o Student) e uno di questi sistemi:

- **macOS** 14.2 o successivo (Apple Silicon): la piattaforma principale;
- **Linux** con WebKitGTK 4.1, ALSA/PipeWire e un portachiavi Secret Service (GNOME Keyring o KWallet);
- **Windows** 10/11 con WebView2 (già presente su Windows 11).

Gli account Free non sono supportati: Spotteck lo segnala nelle Impostazioni.

Spotteck riproduce l’audio da solo, come dispositivo Spotify Connect. Non serve Spotify Desktop, nessun motore esterno, nessuna chiave personale e nessun Client ID.

## Installare

- **macOS:** apri il DMG e trascina Spotteck in Applicazioni. Il pacchetto non è notarizzato Apple, quindi al primo avvio macOS lo blocca: apri **Impostazioni di Sistema → Privacy e sicurezza**, scorri fino a «Spotteck è stato bloccato» e premi **Apri comunque** (su macOS 14 basta anche clic destro → Apri). Se macOS dice invece che **Spotteck è danneggiato e non può essere aperto**, il file non è rotto: è un pacchetto scaricato senza firma (le build precedenti a questa correzione). Rimuovi la quarantena dal Terminale e riaprilo:

  ```
  xattr -dr com.apple.quarantine /Applications/Spotteck.app
  ```

  Se il messaggio resta, firma la copia locale con `codesign --force --deep --sign - /Applications/Spotteck.app`.
- **Linux:** installa il `.deb` (`sudo apt install ./Spotteck_*.deb`) oppure rendi eseguibile l’`.AppImage` e avvialo.
- **Windows:** avvia l’installer `Spotteck_*-setup.exe`. Non è firmato: SmartScreen può chiedere conferma (Ulteriori informazioni → Esegui comunque).

Dati e playlist aggiunte restano nella cartella dati dell’app (`~/Library/Application Support/com.braun.spotteck` su macOS, `~/.local/share/com.braun.spotteck` su Linux, `%APPDATA%\com.braun.spotteck` su Windows); aggiornare l’app non li cancella. Al primo avvio le playlist aggiunte con Spotteck 1.x vengono importate automaticamente.

## Account e riproduzione

1. Apri le Impostazioni e premi **Accedi**. Il browser mostra la pagina di accesso di Spotify; al termine torna a Spotteck.
2. L’accesso riutilizzabile è salvato nel portachiavi di sistema (Portachiavi di macOS, Gestione credenziali di Windows, Secret Service su Linux): ai riavvii successivi Spotteck si ricollega da solo. Su Linux senza un portachiavi attivo l’accesso va ripetuto a ogni avvio.
3. La griglia mostra le playlist della tua libreria Spotify. Con **+** puoi aggiungere altre playlist incollando il link (Spotify: Condividi → Copia link alla playlist).
4. Spotteck compare come dispositivo Spotify Connect anche nell’app Spotify del telefono: da lì puoi spostare la riproduzione sul computer. Se un altro dispositivo sta suonando, Play su Spotteck porta la riproduzione qui.
5. L’uscita è sempre quella predefinita del sistema. Lo slider controlla il volume di Spotteck. I tasti multimediali funzionano tramite Now Playing e Centro di controllo su macOS, MPRIS su Linux e i controlli multimediali di Windows.

**Disconnetti** ferma la riproduzione e cancella l’accesso dal portachiavi; le playlist aggiunte con + restano.

## Visualizzatori

Spotteck analizza direttamente l’audio che sta riproducendo. Non chiede permessi di registrazione, non apre il microfono e non salva nulla. Spettro, onda e i due VU (RMS e picchi stereo separati) seguono il segnale reale; in pausa i visualizzatori restano fermi.

## Sviluppo

Su tutte le piattaforme servono Rust (stable, ≥ 1.85) e Node.js ≥ 22 con npm. In più:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux** (Debian/Ubuntu): `sudo apt install build-essential libwebkit2gtk-4.1-dev libasound2-dev libssl-dev libdbus-1-dev librsvg2-dev file`.
- **Windows:** Visual Studio Build Tools con «Sviluppo di applicazioni desktop con C++» e WebView2.

```
npm ci
npm start            # tauri dev
npm test             # cargo test --workspace + node --test
npm run check:ui     # prova isolata dell’interfaccia in Chromium (Playwright)
npm run pack         # solo l’eseguibile, senza pacchetto
npm run dist         # pacchetti per il sistema in uso: .app + .dmg, .deb + .AppImage, installer NSIS .exe
npm run pack:mac     # Spotteck.app per Apple Silicon
npm run dist:mac     # .app + .dmg per Apple Silicon
```

I pacchetti finiscono in `target/release/bundle/`. Su macOS `Spotteck.app` è firmata ad-hoc (`signingIdentity: "-"`): basta per avviarla su Apple Silicon, ma Gatekeeper chiede conferma al primo avvio. Per una build firmata e notarizzata servono un certificato Developer ID e, nei secret del repository, `APPLE_CERTIFICATE` (il `.p12` in base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (password specifica per app) e `APPLE_TEAM_ID`: la CI li passa a Tauri, che firma e notarizza. La CI di GitHub Actions (`.github/workflows/ci.yml`) parte solo con i push su `main`, i tag `v*`, le pull request verso `main` e l’avvio manuale: formattazione, clippy, test su macOS, Linux e Windows e prova dell’interfaccia; tranne che per le pull request costruisce anche i pacchetti delle tre piattaforme e li allega come artefatti.

Il codice Rust è diviso in:

- `crates/spotteck-core`: stato del lettore, disponibilità, playlist aggiunte, analisi audio. Nessuna dipendenza di sistema: i test girano su qualsiasi piattaforma.
- `crates/spotteck-spotify`: collegamento a Spotify tramite librespot (accesso, Spotify Connect, libreria, copia dell’audio per i visualizzatori).
- `src-tauri`: l’app Tauri (finestra, comandi, eventi, portachiavi, controlli multimediali).
- `ui`: l’interfaccia HTML/CSS/JS.

librespot è una libreria open source non ufficiale: se Spotify cambia il protocollo, può servire aggiornarla.
