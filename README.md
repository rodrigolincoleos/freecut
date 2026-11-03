# FreeCut

Editor de video en español, construido con React, TypeScript y Vite. La interfaz se puede instalar como PWA en navegadores compatibles y está preparada para añadir adaptadores de almacenamiento sin acoplar el modelo del proyecto a un proveedor de nube.

## Requisitos

- Node.js 20.19+ o 22.12+
- npm

## Desarrollo

```sh
npm install
npm run dev
```

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

## Beta en Nginx

FreeCut se publica como sitio estático en `freecut.cincodadosrojos3d.cl`; no necesita Node.js ni un proceso de servidor en producción. El ejemplo de Nginx está en [`deploy/nginx-freecut.conf.example`](./deploy/nginx-freecut.conf.example) y usa un webroot separado (`/home/sodro/freecut`), sin cambiar el sitio principal. Ajusta las rutas del certificado a las que realmente use tu servidor antes de habilitarlo.

El beta está protegido con HTTP Basic Auth de Nginx. Crea el archivo de contraseñas fuera del webroot, por ejemplo con `htpasswd -B -c /etc/nginx/.htpasswd-freecut usuario-beta`, y limita sus permisos al usuario/grupo de Nginx. En Debian/Ubuntu, `htpasswd` se instala con `apache2-utils`; en otras distribuciones el paquete suele llamarse `httpd-tools`. Nunca guardes credenciales en este repositorio.

El workflow [deploy-beta.yml](./.github/workflows/deploy-beta.yml) compila en un runner hospedado por GitHub y publica la compilación en un runner self-hosted del servidor. El servidor usa una IP privada, así que no hace falta exponer SSH a Internet ni guardar una llave SSH de despliegue en GitHub. Se despliega al hacer push a `main`; también se puede iniciar manualmente desde GitHub Actions, solo para la rama `main`. No se despliega desde pull requests.

Configuración inicial:

1. En GitHub, abre `rodrigolincoleos/freecut` → **Settings → Actions → Runners → New self-hosted runner**. Sigue las instrucciones generadas por GitHub para Linux x64; no compartas ni guardes el token temporal del runner en el repositorio. Registra el runner con la etiqueta adicional `freecut-deploy`.
2. Ejecuta el runner como un usuario Linux dedicado, sin privilegios de root. Ese usuario necesita permiso para crear directorios y actualizar enlaces dentro de `/home/sodro/freecut`. El runner de este repositorio puede ejecutar workflows de despliegue; mantén el acceso de escritura al repositorio limitado a personas de confianza y protege la rama `main`.
3. Como el webroot está bajo `/home/sodro`, el usuario de los workers de Nginx necesita permiso de recorrido en `/home/sodro` y acceso de lectura a las releases. Identifica el usuario con la directiva `user` de `/etc/nginx/nginx.conf` (o revisando los procesos worker), y configura ACL solo para ese usuario: permiso `--x` en `/home/sodro` y `/home/sodro/freecut`, y lectura/recorrido (`r-X`) en `/home/sodro/freecut/releases`, también como ACL predeterminada para las releases futuras. No hagas el directorio personal globalmente legible.
4. Crea el archivo de contraseñas de Basic Auth fuera del webroot, por ejemplo con `htpasswd -B -c /etc/nginx/.htpasswd-freecut usuario-beta`, y limita sus permisos al usuario/grupo de Nginx. En Debian/Ubuntu, `htpasswd` se instala con `apache2-utils`; en otras distribuciones el paquete suele llamarse `httpd-tools`. Nunca guardes credenciales en este repositorio.
5. Ajusta las rutas del certificado en la configuración de Nginx a las que realmente use tu servidor. Si ya existe un bloque para ese subdominio, intégralo en vez de habilitar un duplicado. Valida y recarga Nginx con `sudo nginx -t` y `sudo systemctl reload nginx`.

Cada ejecución crea una carpeta de release bajo `/home/sodro/freecut/releases` y cambia el enlace `current` al terminar la copia, sin modificar el directorio del sitio principal ni dejar una actualización parcial servida. Conserva las releases anteriores para rollback. En caso de que el runner deje de estar disponible, la app actualmente publicada sigue sirviéndose desde la última release.

Para revertir una publicación, sustituye `<release-anterior>` por el nombre de una carpeta existente bajo `releases` y ejecuta:

```sh
ln -s /home/sodro/freecut/releases/<release-anterior> /home/sodro/freecut/current.rollback
mv -Tf /home/sodro/freecut/current.rollback /home/sodro/freecut/current
```

Basic Auth restringe el acceso a la aplicación, pero no crea cuentas dentro de FreeCut. Los proyectos y medios se almacenan localmente en el navegador de cada tester; no se suben al servidor ni se sincronizan entre dispositivos. Como en otras PWA, un dispositivo que ya inició sesión puede conservar recursos en caché para uso offline; quitarle acceso al servidor no borra esa caché local.

## Funciones disponibles

- Importar video y audio local, con vista previa de clips.
- Ordenar clips de video arrastrándolos en la línea de tiempo.
- Recortar inicio y final por clip.
- Añadir un título y subtítulos manuales.
- Aplicar filtros básicos.
- Exportar el clip seleccionado como WebM, incluyendo el audio original cuando el navegador lo permite.
- Guardar automáticamente el proyecto y sus archivos en IndexedDB, en el navegador y dispositivo actuales.
- Crear y restaurar copias portables `.freecut` con el proyecto y sus medios.
- Instalar la interfaz como PWA; el service worker guarda los archivos de la aplicación para volver a abrirla sin conexión después de la primera carga.

## Almacenamiento y límites actuales

`ProjectRepository` separa la lectura y escritura del proyecto de la interfaz. La implementación actual usa IndexedDB local; no hay cuentas, sincronización entre dispositivos ni conexión a un NAS. El proyecto solo se recupera automáticamente en el mismo navegador y dispositivo, y puede perderse si se borran los datos del navegador o se agota su cuota. Usa **Copia** para descargar un respaldo y **Restaurar** para reemplazar el proyecto local; los respaldos incluyen los medios originales y no se comprimen.

La línea de tiempo permite ordenar clips, pero la vista previa y la exportación siguen operando sobre un clip a la vez. Aún no se unen clips, no se mezclan las pistas de audio importadas ni se generan transcripciones automáticas. Se generaron los shells nativos de Android e iOS, pero todavía no se han probado en dispositivos ni se ha configurado la exportación/renderizado nativo. La versión de escritorio aún no tiene empaquetador.

El siguiente salto de producto es hacer que la línea de tiempo reproduzca y renderice secuencias completas y añadir mezcla de audio y subtitulado automático. El repositorio está aislado para que más adelante se pueda añadir un adaptador de NAS/API sin cambiar el editor.

## Validación

```sh
npm run build
```
