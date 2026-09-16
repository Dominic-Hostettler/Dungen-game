# Leo's Dungeon RPG – Setup & Deployment

Echtzeit-Multiplayer-Dungeon-RPG (Node.js + Socket.io Server, Canvas-Client).
Klassen: Krieger, Magier, Schurke. Bis zu ~6 Spieler gleichzeitig, Monster,
Items, Leveling.

## 1. Lokal testen (optional)

```
npm install
npm start
```

Dann im Browser: http://localhost:3000

## 2. Kostenlos auf Render deployen

1. Erstelle einen kostenlosen Account auf https://render.com
2. Lade diesen Ordner (`dungeon-rpg/`) in ein neues GitHub-Repository hoch
   (oder nutze "Deploy from Git" mit einem eigenen Repo).
3. In Render: **New +** → **Web Service** → dein Repo auswählen
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Deploy klicken. Nach ein paar Minuten bekommst du eine URL wie
   `https://leo-dungeon-rpg.onrender.com`

Hinweis: Der kostenlose Render-Plan "schläft" nach Inaktivität ein und
braucht beim ersten Aufruf ca. 30-60 Sekunden zum Aufwachen. Für ein
Hobby-Projekt völlig ok.

Alternativen mit ähnlichem Ablauf: Railway.app, Fly.io.

## 3. Auf leo.widescreen.ch einbinden

Da dein Haupthosting (METANET, per FileZilla) kein Node.js ausführen kann,
bleibt die Website dort – du verlinkst nur auf den extern gehosteten Server.

**Einfachste Variante:** Einen Link/Button auf deiner Seite platzieren:

```html
<a href="https://leo-dungeon-rpg.onrender.com" target="_blank">
  ⚔️ Jetzt spielen: Leo's Dungeon
</a>
```

**Alternative (eingebettet via iframe)** – lade dazu z.B. eine kleine
`game.html` mit folgendem Inhalt per FileZilla hoch und verlinke diese:

```html
<!DOCTYPE html>
<html>
<head><title>Leo's Dungeon</title>
<style>html,body{margin:0;height:100%;}iframe{width:100%;height:100%;border:0;}</style>
</head>
<body>
<iframe src="https://leo-dungeon-rpg.onrender.com" allow="fullscreen"></iframe>
</body>
</html>
```

## Dateien

- `server.js` – Spiel-Server (Bewegung, Kämpfe, Monster-KI, Items, Leveling)
- `public/index.html` – Client (Canvas-Rendering, Steuerung, HUD)
- `package.json` – Abhängigkeiten (express, socket.io)

## Steuerung im Spiel

- **WASD / Pfeiltasten**: Bewegen
- **Leertaste / Linksklick**: Angriff (Magier zielt Richtung Maus)
- **E**: Heiltrank benutzen
- **Enter** (im Chat-Feld): Nachricht senden

## Mögliche Erweiterungen (später)

- Weitere Dungeon-Level / Portale zwischen Räumen
- Ausrüstung (Waffen/Rüstung) statt nur Tränke
- Boss-Monster
- Persistente Charaktere (Datenbank statt In-Memory)
