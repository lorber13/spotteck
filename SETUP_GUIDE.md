# Spotteck 1.1 — installazione e sviluppo

## Requisiti

Mac Apple Silicon con macOS 14.2 o successivo. Spotify Desktop serve per il primo abbinamento Soloist e per gli account Free. Per Premium, dopo l’abbinamento Spotteck può suonare con Spotify chiuso.

## Installare

Apri il DMG e trascina Spotteck in Applicazioni. Dati, playlist e credenziali restano in `~/Library/Application Support/Spotteck`; aggiornare l’app non li cancella. Il pacchetto locale non è notarizzato Apple.

## Account e riproduzione

1. Effettua il login nelle Impostazioni di Spotteck. L’accesso usa PKCE e token cifrati con il Portachiavi; non richiede un Client Secret.
2. Gli account Free continuano a usare Spotify Desktop.
3. Per Premium installa Spotify Soloist dal download ufficiale Apple Silicon: https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates . Colloca l’eseguibile `soloist`, con permesso di esecuzione, in `~/Library/Application Support/Spotteck/engines/soloist/soloist`.
4. Genera la tua chiave personale da https://developer.spotify.com/dashboard/soloist . Incollala nel campo protetto di Spotteck e premi **Salva e collega**. Non pubblicarla né inviarla in chat.
5. Nel menu Dispositivi di Spotify scegli il nome Spotteck indicato nelle Impostazioni. Spotteck annuncia l’endpoint attraverso Bonjour di macOS e salva l’associazione. Al termine riavvia automaticamente il motore per usare la sessione salvata.
6. Dopo il collegamento puoi chiudere Spotify. Il volume del motore parte al 100%; lo slider controlla il volume del lettore. L’uscita è sempre quella predefinita di macOS.

Il binario Soloist e le chiavi personali non sono inclusi nei pacchetti né nel repository. Le build Soloist scadono: aggiorna il binario quando richiesto. Non stampare gli argomenti del processo, perché la CLI ufficiale riceve la chiave all’avvio. Spotteck non inoltra né conserva i log del motore: estrae soltanto il numero della porta pubblica ZeroConf per Bonjour.

Logout e cambio account fermano il motore. Il logout cancella le credenziali cifrate e la sessione Soloist locale, ma conserva le playlist personali dell’app.

## Visualizzatori

Autorizza l’acquisizione dell’audio di sistema quando macOS la richiede. Il programma nativo analizza esclusivamente Soloist o Spotify Desktop: non apre il microfono, non salva registrazioni e non modifica l’uscita audio. Spettro e onda provengono dai campioni reali; i due VU ricevono livelli RMS e picchi stereo separati. In assenza di segnale i visualizzatori restano fermi.

Un mixer come FineTune può intercettare l’audio prima del tap: se senti musica ma Spotteck segnala silenzio, verifica il permesso in Privacy e sicurezza > Registrazione schermo e audio di sistema e la configurazione del mixer. Spotteck non chiude app di terzi.

## Sviluppo

Richiede Node.js/npm e Xcode oppure Command Line Tools, con SDK che esponga Core Audio Process Taps.

```
npm ci
npm start
```

`npm start` compila l’analizzatore per arm64 con deployment target macOS 14.2. Le versioni Electron e builder sono fissate e allineate con il lockfile.

```
npm test
npm run build:audio
build/native/audio-meter --self-test
npm run pack
npm run dist
```

Per la prova isolata dell’interfaccia:

```
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tools/check-premium-ui.js
```

Il bundle include soltanto `src`, metadati del pacchetto e il programma audio nativo compilato. Test, screenshot, backup, sorgenti Swift e chiavi non vengono distribuiti. Le playlist vengono salvate tramite file temporaneo e rinomina; errori e archivi corrotti vengono segnalati senza sovrascrivere il file precedente.
