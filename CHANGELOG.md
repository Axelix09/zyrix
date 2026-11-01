# Changelog

## 0.16.0 — 2026-10-31

- Añade entrada de media `{ stream }` a envío con staging temporal privado y subida cifrada por bloques (requiere espacio temporal local).
- Añade `downloadMediaToFile()` para descargar/descifrar por bloques, validar MAC y crear el archivo final atómicamente sin sobrescribir.
- Actualiza documentación para reflejar pruebas manuales con WhatsApp real, informadas por el autor.

## 0.15.0 — 2026-10-31

- Añade cifrado AES-256-GCM opcional de snapshots de autenticación con clave derivada mediante scrypt, para archivos y adapters.
- Añade `sessionEncryptionKey` a `start`, `createLauncher` y `connect`; al habilitarlo en una sesión heredada, migra su snapshot y respaldo a formato cifrado.
- Endurece permisos POSIX de directorios/archivos de sesión y rechaza symlinks directos en los archivos sensibles.
- Evita silencios en errores de guardado y permite que `flush()` reporte fallos. El adapter público Mongo limita el tamaño BSON y persiste métricas de bytes.
- Bloquea URLs de media que resuelven a IPs privadas, loopback, link-local o reservadas; revalida redirects, limita puertos y elimina credenciales en redirects entre hosts.
- Añade timeout y límite de tamaño a respuestas de media.
- Repara las declaraciones TypeScript y añade un smoke test de consumidor.
- Añade pruebas de núcleo y CI para Node 18/22; `npm test` falla si no detecta pruebas.
- Actualiza la versión del paquete a `0.15.0`.
