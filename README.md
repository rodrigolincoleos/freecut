# FreeCut

Editor de video en español, construido con React, TypeScript y Vite. La interfaz se puede instalar como PWA en navegadores compatibles y está preparada para añadir adaptadores de almacenamiento sin acoplar el modelo del proyecto a un proveedor de nube.

## Requisitos

- Node.js 20.19+ o 22.12+
- npm

## Desarrollo

```sh
npm install
cp .env.example .env.local
npm run dev
```

Edita `.env.local` con la configuración pública de la SPA antes de iniciar. El archivo está excluido de Git.

## Aplicaciones móviles

Capacitor comparte la app React con los proyectos nativos de Android e iOS. Después de cambiar el frontend, ejecuta:

```sh
npm run native:sync
npm run android
```

Android requiere Android Studio, Android SDK y un JDK compatible. Para abrir/compilar iOS se necesita macOS con Xcode:

```sh
npm run ios
```

La PWA funciona en navegadores compatibles bajo HTTPS (o localhost). El service worker almacena el shell y los recursos estáticos; no guarda los videos en caché de red.

## Auth0 y despliegue web

FreeCut usa Auth0 Universal Login para la web y protege el endpoint de transcripción con access tokens validados en FastAPI. No hay servidor Express ni base de datos de usuarios/proyectos. Configura los valores públicos de la SPA en `.env.local` (usa `.env.example` como referencia); nunca agregues Client Secrets ni tokens al frontend o al repositorio:

```dotenv
VITE_AUTH0_DOMAIN=tu-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=client-id-de-la-spa
VITE_AUTH0_AUDIENCE=api-identifier-de-freecut
```

En Auth0 Dashboard:

1. Crea una aplicación **Single Page Application** con Authorization Code + PKCE. Allowed Callback URLs y Allowed Logout URLs deben incluir `https://freecut.cincodadosrojos3d.cl/`; Allowed Web Origins debe incluir `https://freecut.cincodadosrojos3d.cl` sin barra final. Para desarrollo local agrega temporalmente `http://localhost:5173/` en callbacks/logout y `http://localhost:5173` en Web Origins.
2. Crea una API propia con identificador `https://api.freecut.cincodadosrojos3d.cl` (es un audience y **no** el endpoint público de servidor ni el Management API). Usa RS256 y define el scope `transcribe:run`. La API comprueba ese scope y los claims firmados de rol/correo en el servidor. No habilites RBAC de permisos hasta definir cómo asignar automáticamente el rol Auth0 `USER` a nuevos usuarios; no concedas `ADMIN` desde el signup. CORS adicional no hace falta mientras el navegador y `/api/` sean same-origin.
3. En Universal Login habilita la conexión de usuarios elegida, signup, recuperación de contraseña, envío/verificación de correo y, si se requiere, MFA. El Post Login Action fuente está en [`auth0/actions/freecut-post-login.js`](./auth0/actions/freecut-post-login.js): agrégalo al Login flow. Bloquea usuarios sin correo verificado, emite los claims de rol con namespace y asigna el rol Auth0 `ADMIN` solo desde el Dashboard a cuentas autorizadas. El resto recibe el claim `USER`.

El tenant entregado para esta integración tiene prefijo `dev-`; úsalo para desarrollo/staging. Antes de producción confirma un tenant productivo y configura en él la SPA, la API, el Action y los callbacks del dominio final; actualiza el dominio de Auth0 tanto en el frontend como en systemd.

La app no muestra herramientas ni carga proyectos hasta que Auth0 resuelve una sesión autenticada. El SDK mantiene los tokens en memoria. El backend valida firma/JWKS, issuer, audience y expiración; requiere correo verificado, rol `USER` o `ADMIN` y scope `transcribe:run`. La falta de token válido devuelve 401 y la falta de permiso 403. `/health` solo informa disponibilidad técnica y no expone datos de usuario.

El proyecto anterior guardado con la clave local `default` queda sin asignar. La primera cuenta puede importarlo explícitamente; la operación registra una única cuenta propietaria en ese navegador y conserva intacta la copia original. Cada cuenta tiene un espacio local distinto basado en el `sub` Auth0. Esto no sincroniza proyectos entre dispositivos ni reemplaza una autorización de servidor para proyectos en nube. Aún no existen endpoints ni panel de administración; los claims ADMIN son una base para futuras funciones, no crean APIs administrativas.

Si la apertura de un proyecto local queda esperando, cierra las demás pestañas o ventanas de FreeCut y vuelve a intentar. La aplicación informa si IndexedDB está bloqueada o tarda demasiado; ese mensaje no implica que los proyectos se hayan borrado.

El frontend sigue siendo estático: Nginx sirve los recursos y reenvía `/api/` a FastAPI en `127.0.0.1:8765`. El ejemplo completo está en [`deploy/nginx-freecut.conf.example`](./deploy/nginx-freecut.conf.example). Retira el `auth_basic` compartido del virtual host FreeCut: además de duplicar el login, su header Basic es incompatible con el `Authorization: Bearer` de la API. Nginx debe reenviar `Authorization` al servicio y no cachear `/api/`. Revisa el archivo real del host, prueba `sudo nginx -t` y recarga solo en la ventana de despliegue aprobada.

El servicio procesa una transcripción a la vez, limita cada carga a 512 MB y elimina los temporales también en caso de error. Instala o actualiza su entorno y configuración systemd después de actualizar el código:

```sh
sudo bash /home/sodro/freecut-source/deploy/install-transcription-service.sh
```

El servidor necesita Git, Node.js 22.12 o posterior, npm, HTTPS saliente a GitHub y HTTPS saliente al dominio Auth0 para descargar JWKS. El script de despliegue aborta si faltan las variables públicas de build. Como `sodro`, configúralas en el entorno de la sesión antes de cada publicación:

```sh
export VITE_AUTH0_DOMAIN='tu-tenant.us.auth0.com'
export VITE_AUTH0_CLIENT_ID='client-id-de-la-spa'
export VITE_AUTH0_AUDIENCE='api-identifier-de-freecut'
git -C /home/sodro/freecut-source pull --ff-only
bash /home/sodro/freecut-source/deploy/deploy-from-github.sh
```

Cada ejecución compila `main`, crea una release bajo `/home/sodro/freecut/releases` y cambia `current` de forma atómica; conserva releases anteriores para rollback. El servicio systemd configura el issuer y audience de la API. Si se cambia el tenant o el API Identifier, actualiza también `deploy/freecut-transcription.service` y vuelve a instalar el servicio.

La PWA funciona en navegadores compatibles bajo HTTPS (o localhost) y cachea el shell estático. El contenido privado y la API siguen dependiendo de la sesión/token; cerrar sesión no borra las copias locales del navegador. Los shells nativos de Capacitor requieren callbacks/deep links y un flujo de navegador del sistema antes de habilitar Auth0 en Android/iOS; esta integración inicial cubre la web.

## Funciones disponibles

- Importar video y audio local, con vista previa de clips.
- Ordenar clips de video arrastrándolos en la línea de tiempo.
- Mover la posición de reproducción pulsando la regla de tiempo o arrastrando el cabezal sobre los clips.
- Recortar inicio y final por clip.
- Transformar cada clip con rotación horaria/antihoraria, espejo horizontal/vertical y controles de escala desde los bordes y vértices en la vista previa. Arrastra la imagen para moverla; el borde discontinuo marca el lienzo y permite ver el video fuera del área de edición. Restablece la transformación desde el inspector.
- Cortar un clip haciendo clic en el punto deseado de la línea de tiempo, dividirlo en la posición actual y eliminar clips desde la barra inferior de edición.
- Ajustar velocidad, avance inverso, volumen y fundidos de audio/video del clip seleccionado. Estos ajustes se guardan y se aplican a la vista previa y a la exportación del clip.
- En avance inverso se silencia el audio original, ya que el navegador no reproduce audio hacia atrás. Las pistas de audio importadas se pueden previsualizar, pero todavía no se mezclan en la exportación.
- Añadir un título y subtítulos manuales.
- Generar subtítulos con transcripción local en el servidor, editar texto y tiempos de cada segmento y elegir estilos Limpio, Contorno, Recuadro rosa, Itálica, Palabra clave, Condensado, Serif o Minimal. El estilo seleccionado se guarda con el proyecto y se incluye en la exportación.
- Elegir formatos de video Original, 9:16, 16:9, 1:1, 4:3, 3:4, 3:2, 2:1, 2.35:1, 1.85:1 o 128:27. El video completo conserva sus proporciones dentro del lienzo, con bandas si hace falta; el formato se conserva en el proyecto, la copia de seguridad y la exportación.
- Aplicar filtros básicos.
- Exportar el clip seleccionado como WebM, incluyendo el audio original cuando el navegador lo permite.
- Guardar automáticamente el proyecto y sus archivos en IndexedDB, en el navegador y dispositivo actuales.
- Crear y restaurar copias portables `.freecut` con el proyecto y sus medios.
- Instalar la interfaz como PWA; el service worker guarda los archivos de la aplicación para volver a abrirla sin conexión después de la primera carga.

## Almacenamiento y límites actuales

`ProjectRepository` separa la lectura y escritura del proyecto de la interfaz. La implementación actual usa IndexedDB local; no hay cuentas, sincronización entre dispositivos ni conexión a un NAS. El proyecto solo se recupera automáticamente en el mismo navegador y dispositivo, y puede perderse si se borran los datos del navegador o se agota su cuota. Usa **Copia** para descargar un respaldo y **Restaurar** para reemplazar el proyecto local; los respaldos incluyen los medios originales y no se comprimen.

La línea de tiempo permite ordenar clips, pero la vista previa y la exportación siguen operando sobre un clip a la vez. Aún no se unen clips ni se mezclan las pistas de audio importadas. Se generaron los shells nativos de Android e iOS, pero todavía no se han probado en dispositivos ni se ha configurado la exportación/renderizado nativo. La versión de escritorio aún no tiene empaquetador.

El siguiente salto de producto es hacer que la línea de tiempo reproduzca y renderice secuencias completas y añadir mezcla de audio y subtitulado automático. El repositorio está aislado para que más adelante se pueda añadir un adaptador de NAS/API sin cambiar el editor.

## Validación

```sh
npm run build
```
