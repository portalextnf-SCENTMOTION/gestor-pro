# Gestor Pro — Gestión Comercial (versión web)

Esta es la versión web de Gestor Pro: la misma aplicación de siempre, pero ahora con:
- **Login con contraseña** — solo tú puedes entrar.
- **Base de datos real (PostgreSQL en Neon)** — los datos se guardan solos, en cuanto haces un cambio. Ya no hace falta exportar/importar el JSON a mano (aunque los botones se mantienen como copia de seguridad manual opcional).

## La arquitectura elegida (y por qué)

- **Base de datos → [Neon](https://neon.tech)**: PostgreSQL gratis para siempre, sin tarjeta, sin fecha de caducidad. Se "duerme" tras un rato sin uso, pero se despierta sola en cuanto la app se conecta — nunca borra nada.
- **Servidor web → Render**, plan gratuito: aloja la aplicación (Node.js). También se duerme tras 15 minutos sin uso (la primera visita del día tarda 30-60 segundos en despertar), pero como los datos viven en Neon y no en Render, esto no supone ningún riesgo de pérdida de información.

**Coste total: 0 €/mes.**

---

## Paso 1 — Crear la base de datos en Neon

1. Ve a [neon.tech](https://neon.tech) y crea una cuenta gratuita (puedes entrar con GitHub).
2. Crea un proyecto nuevo, por ejemplo llamado `gestor-pro`.
3. En el panel del proyecto, busca el botón **"Connection string"** (o "Connect"). Copia la cadena que empieza por `postgres://...` — la necesitarás en el Paso 3.
   - No hace falta que la modifiques ni le quites nada; el servidor ya está preparado para funcionar con el formato que da Neon (incluido el `sslmode=require` que añade por defecto).

## Paso 2 — Subir el proyecto a GitHub

1. Ve a [github.com](https://github.com) y crea una cuenta si no tienes.
2. Pulsa "New repository". Ponle un nombre, por ejemplo `gestor-pro`. Puede ser **privado**.
3. En tu ordenador, abre una terminal dentro de esta carpeta del proyecto y ejecuta:
   ```
   git init
   git add .
   git commit -m "Primera versión de Gestor Pro web"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/gestor-pro.git
   git push -u origin main
   ```
   (Sustituye `TU-USUARIO` por tu usuario de GitHub).

   Si prefieres no usar la terminal, GitHub también permite arrastrar los archivos directamente desde la web al crear el repositorio.

## Paso 3 — Crear el servicio web en Render

1. Ve a [render.com](https://render.com) (con la misma cuenta donde ya tienes scentmotion).
2. Pulsa "New +" → "Web Service".
3. Conecta tu cuenta de GitHub y elige el repositorio `gestor-pro`.
4. Configuración:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. En "Environment Variables" añade:
   - `DATABASE_URL` → pega aquí la cadena de conexión que copiaste de Neon en el Paso 1.
   - `APP_PASSWORD` → la contraseña que quieras usar para entrar en la app.
   - `SESSION_SECRET` → cualquier texto largo y aleatorio (por ejemplo, genera uno en [randomkeygen.com](https://randomkeygen.com)).
6. Pulsa "Create Web Service". Render construirá y desplegará la app — tarda unos minutos la primera vez.
7. Cuando termine, te dará una URL tipo `https://gestor-pro-xxxx.onrender.com`. Esa es tu app, ya online.

### Alternativa más rápida: despliegue con un clic (Blueprint)

Este proyecto incluye un archivo `render.yaml`. En Render, puedes usar "New +" → "Blueprint", apuntar a tu repositorio, y Render creará el servicio web automáticamente (te pedirá que introduzcas `DATABASE_URL` y `APP_PASSWORD` a mano, ya que por seguridad esas no se generan solas).

## Paso 4 — Cargar tus datos actuales (solo la primera vez)

1. Entra en tu nueva URL de Render.
2. Introduce la contraseña que configuraste.
3. Como es la primera vez, la app estará vacía. Pulsa **"Importar datos"** (arriba a la derecha) y selecciona tu archivo `gestor-pro-datos-2026-09-02.json` (el mismo que usabas hasta ahora).
4. En cuanto se importe, se guardará automáticamente en Neon — a partir de aquí, cualquier cambio que hagas se guarda solo, sin que tengas que hacer nada más.

## Uso diario

- Abre la URL de Render, mete la contraseña, y trabaja con la app exactamente igual que siempre.
- Si llevas más de 15 minutos sin entrar, la primera carga puede tardar hasta un minuto en "despertar" el servidor — es normal, no ha pasado nada malo.
- Arriba a la derecha verás un indicador: **"Guardado"** (todo bien), **"Guardando…"** (justo tras un cambio), o un aviso si hay algún problema de conexión.
- Los botones "Exportar datos" / "Importar datos" se mantienen por si algún día quieres una copia de seguridad manual extra.
- "Cerrar sesión" arriba a la derecha, si compartes el ordenador con alguien.

## Desarrollo local (opcional)

1. Instala [Node.js](https://nodejs.org) en tu ordenador.
2. Copia `.env.example` a `.env` y rellena `DATABASE_URL` con tu cadena de conexión de Neon (o una base de datos Postgres local).
3. Ejecuta:
   ```
   npm install
   npm start
   ```
4. Abre `http://localhost:3000` en el navegador.

## Estructura del proyecto

```
gestor-pro/
├── server.js          → Backend (Node.js + Express + PostgreSQL)
├── package.json        → Dependencias
├── render.yaml          → Configuración de despliegue automático en Render
├── .env.example         → Plantilla de variables de entorno (no subir el .env real)
└── public/
    └── index.html        → La aplicación (el mismo Gestor Pro de siempre, con login y guardado automático añadidos)
```

## Seguridad

- La contraseña de acceso vive en la variable de entorno `APP_PASSWORD` en Render — nunca en el código.
- La sesión se guarda en una cookie firmada, válida 30 días, y no queda registrada en ningún sitio del servidor (no hace falta base de datos de sesiones).
- Si alguna vez sospechas que alguien más tiene tu contraseña, cámbiala en las variables de entorno de Render y todas las sesiones antiguas dejarán de funcionar automáticamente en cuanto cambies también `SESSION_SECRET`.

## Sobre scentmotion-db

Si más adelante quieres migrar también `scentmotion-db` a Neon para ahorrarte esos ~7$/mes de Render, es totalmente posible siguiendo el mismo patrón — pero al ser una base de datos ya en producción, conviene hacerlo con una copia de seguridad de por medio y con calma, no a la vez que este primer despliegue.
