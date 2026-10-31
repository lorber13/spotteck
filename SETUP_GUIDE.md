# Spotteck 3.0 — installazione e sviluppo

Spotteck usa **solo le API ufficiali di Spotify**: la Web API per comandi, stato e libreria, l’accesso OAuth (PKCE) di `accounts.spotify.com` e oEmbed per le copertine delle playlist aggiunte. Non riproduce l’audio da sé: è un telecomando per le app Spotify ufficiali.

## Requisiti

- Un account **Spotify Premium** (anche Family, Duo o Student): i comandi di riproduzione della Web API richiedono Premium. Gli account Free non sono supportati e Spotteck lo segnala nelle Impostazioni.
- L’app **Spotify ufficiale** aperta da qualche parte: su questo computer (Spotify Desktop), sul telefono o su un altoparlante Spotify Connect. Spotteck comanda il dispositivo attivo; se non ce n’è uno, sveglia Spotify su questo computer.
- Una **app Spotify for Developers** tua, gratuita, per il Client ID (vedi sotto).
- Uno di questi sistemi:
  - **macOS** 14.2 o successivo (Apple Silicon): la piattaforma principale;
  - **Linux** con WebKitGTK 4.1, PipeWire e un portachiavi Secret Service (GNOME Keyring o KWallet);
  - **Windows** 10 versione 2004 o successiva / Windows 11, con WebView2 (già presente su Windows 11).

## Creare la tua app Spotify (Client ID)

Ogni utente usa la propria app: Spotify limita le app in modalità sviluppo a pochi utenti, e così il tuo accesso non dipende da nessun altro. Ci vogliono due minuti.

1. In Spotteck apri le **Impostazioni** e premi **Apri dashboard** (oppure vai su <https://developer.spotify.com/dashboard>) e accedi con il tuo account Spotify.
2. Premi **Create app**. Nome e descrizione sono a scelta (es. «Spotteck»).
3. In **Redirect URIs** aggiungi esattamente `http://127.0.0.1:43821/callback` (nelle Impostazioni c’è il tasto **Copia**).
4. In **Which API/SDKs are you planning to use?** seleziona **Web API**, accetta i termini e salva.
5. Apri **Settings** dell’app, copia il **Client ID** (32 caratteri) e incollalo in Spotteck, poi premi **Salva**. Non serve il Client Secret: Spotteck non lo usa.
6. Se vuoi usare l’app anche con altri account Spotify, aggiungili in **User Management** della dashboard.

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

1. Dopo aver salvato il Client ID premi **Accedi**. Il browser mostra la pagina di accesso di Spotify con i permessi richiesti (profilo e piano, stato e comandi della riproduzione, le tue playlist); al termine torna a Spotteck.
2. L’accesso è salvato nel portachiavi di sistema (Portachiavi di macOS, Gestione credenziali di Windows, Secret Service su Linux): ai riavvii successivi Spotteck si ricollega da solo. Su Linux senza un portachiavi attivo l’accesso va ripetuto a ogni avvio. Chi aggiorna da Spotteck 2 deve inserire il Client ID e accedere di nuovo.
3. La griglia mostra le playlist della tua libreria Spotify. Con **+** puoi aggiungere altre playlist incollando il link (Spotify: Condividi → Copia link alla playlist). Spotify elenca i brani solo delle playlist tue o collaborative: le altre si avviano comunque con un clic.
4. I comandi vanno al dispositivo Spotify che sta suonando (computer, telefono, altoparlante). Se nessuno è attivo, Play riprende su Spotify di questo computer, altrimenti sul primo dispositivo disponibile. Lo slider regola il volume di quel dispositivo, dove Spotify lo consente.
5. I tasti multimediali e Now Playing restano all’app Spotify ufficiale.

**Disconnetti** cancella l’accesso dal portachiavi; la riproduzione sui tuoi dispositivi continua e le playlist aggiunte con + restano. Cambiare Client ID richiede un nuovo accesso.

## Visualizzatori

I visualizzatori ascoltano soltanto l’audio dell’app Spotify **su questo computer**, con l’acquisizione per processo del sistema operativo: non aprono il microfono, non salvano nulla e non cambiano l’uscita audio. Spettro, onda e i due VU (RMS e picchi stereo separati) seguono il segnale reale; in pausa, o quando Spotify suona su un altro dispositivo, restano fermi.

- **macOS:** un *process tap* di Core Audio su Spotify. Al primo uso macOS chiede il permesso «Registrazione solo audio di sistema»; se l’hai negato, riattivalo in **Impostazioni di Sistema → Privacy e sicurezza → Registrazione schermo e audio di sistema**.
- **Windows:** la cattura per processo di WASAPI (process loopback) su Spotify.exe; nessun permesso richiesto.
- **Linux:** uno stream PipeWire collegato a quello di Spotify (come `pw-record --target`); non passa mai ad altre sorgenti. Senza PipeWire i visualizzatori non sono disponibili.

## Sviluppo

Su tutte le piattaforme servono Rust (stable, ≥ 1.85) e Node.js ≥ 22 con npm. In più:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux** (Debian/Ubuntu): `sudo apt install build-essential libwebkit2gtk-4.1-dev libpipewire-0.3-dev libclang-dev libssl-dev libdbus-1-dev librsvg2-dev file`.
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

- `crates/spotteck-core`: stato del lettore, disponibilità, risposte della Web API, PKCE, impostazioni, playlist aggiunte, analisi audio. Nessuna dipendenza di sistema: i test girano su qualsiasi piattaforma.
- `crates/spotteck-spotify`: il collegamento a Spotify, solo tramite la Web API ufficiale (accesso PKCE con il tuo Client ID, comandi al dispositivo attivo, stato, libreria).
- `crates/spotteck-capture`: l’audio per i visualizzatori, catturato dal processo di Spotify (Core Audio, WASAPI, PipeWire).
- `src-tauri`: l’app Tauri (finestra, comandi, eventi, portachiavi).
- `ui`: l’interfaccia HTML/CSS/JS.

`tests/official-only.test.js` (in `npm test`) fallisce se compaiono client Spotify non ufficiali, Client ID altrui o endpoint privati di Spotify.
