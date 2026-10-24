# Spotteck

> 🤖 **Se sei un utente esperto e vuoi far configurare tutto da Codex, Antigravity o un agente AI, dai a loro questo file e fornisci il file necessario:**  
> 👉 [**SETUP_GUIDE.md**](SETUP_GUIDE.md)

---

### Che cos'è Spotteck?
**Una nuova interfaccia per Spotify. Più bella, essenziale ed elegante.**

Elimina il disordine e le distrazioni dell'app ufficiale, trasformando Spotify in un telecomando compatto ispirato al design industriale **Braun** (Dieter Rams), con eleganti strumenti analogici animati a **60 FPS** (oscilloscopio CRT, cassetta a nastro, VU meter, vinile e fluido Aether-Morph).

---

### 📦 Download & Installazione

| File di Installazione | Piattaforma | Download Diretto |
| :--- | :--- | :--- |
| **Spotteck Installer (DMG)** | macOS (Apple Silicon arm64) | [**Scarica Spotteck-1.0.0-arm64.dmg**](https://github.com/marcovernetto-lgtm/spotteck/releases/download/v1.0.0/Spotteck-1.0.0-arm64.dmg) |
| **Spotteck Archivio (ZIP)** | macOS (Apple Silicon arm64) | [**Scarica Spotteck-1.0.0-arm64-mac.zip**](https://github.com/marcovernetto-lgtm/spotteck/releases/download/v1.0.0/Spotteck-1.0.0-arm64-mac.zip) |

> 📖 **Guida Completa di Installazione & Uso:**  
> Per le istruzioni dettagliate passo-passo consulta la [**Guida Ufficiale (SETUP_GUIDE.md)**](SETUP_GUIDE.md).

---

### 📸 Strumenti & Visualizzatori

| Oscilloscopio CRT | Cassetta a Nastro |
| :---: | :---: |
| ![Oscilloscopio](docs/screenshots/01_oscilloscope.png) | ![Cassetta](docs/screenshots/02_cassette.png) |

| Doppio VU Meter Analogico | Giradischi in Vinile |
| :---: | :---: |
| ![VU Meter](docs/screenshots/03_vu_meter.png) | ![Vinile](docs/screenshots/04_vinyl.png) |

| Fluido Aether-Morph | Cassetto Selezione Brani |
| :---: | :---: |
| ![Aether Morph](docs/screenshots/05_aether_morph.png) | ![Cassetto Tracce](docs/screenshots/06_playlist_drawer.png) |

---

### 🕹️ Comandi Rapidi

* **Clic Sinistro su una Playlist:** Avvia la riproduzione immediata in background (la playlist attiva si illumina con un sottile contorno arancione).
* **Clic Destro su una Playlist:** Apre il cassetto laterale con la lista completa dei brani; la canzone in riproduzione è evidenziata e scorre automaticamente.
* **Frecce Tastiera (`←` / `→`) o Frecce Interfaccia:** Passa al brano precedente o successivo.
* **Barra Spaziatrice:** Play / Pausa.
* **Clic sul Quadrante:** Cambia strumento (Oscilloscopio → Cassetta → VU Meter → Vinile → Aether Morph).
* **Pulsante `+`:** Incolla il link di una qualsiasi playlist Spotify per aggiungerla al deck.

---

### Per Sviluppatori (Build da sorgenti)

```bash
# Installa le dipendenze
npm install

# Avvia l'app in locale
npm start

# Compila il pacchetto macOS .app
npm run pack

# Genera l'installer .dmg
npm run dist
```

---

<sub>*Disclaimer: Spotteck è un progetto open-source indipendente e non è affiliato, sponsorizzato o approvato da Spotify AB. Spotify è un marchio registrato di Spotify AB.*</sub>
