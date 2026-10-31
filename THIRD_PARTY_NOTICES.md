# Avisos de terceros

## Tabla de tokens de WhatsApp Binary

`src/constants.js` contiene la tabla de tokens de protocolo adaptada del paquete [`@raphaelvserafim/whatsapp-binary`](https://github.com/raphaelvserafim/whatsapp-binary), versión 1.0.0, de Raphael Serafim. Se conserva localmente para que el encoder binario no necesite un paquete de tokens en tiempo de ejecución. El código fuente original se distribuye bajo MIT; se incluye el texto de esa licencia en `THIRD_PARTY_LICENSES/whatsapp-binary-MIT.txt`.

## Esquema Protocol Buffers

Zyrix usa [`@wppconnect/wa-proto`](https://github.com/wppconnect-team/wa-proto), versión 2.3000.1049217119, como dependencia para definiciones Protocol Buffers, distribuida bajo Apache License 2.0.

## Primitivas Signal

Zyrix usa el paquete `libsignal` versión 6.0.0 para las primitivas y estructuras del protocolo Signal. Declara licencia GPL-3.0; el texto se incluye en `THIRD_PARTY_LICENSES/libsignal-GPL-3.0.txt`. Por esa dependencia Zyrix se distribuye bajo GPL-3.0-only (ver `LICENSE`). Ten en cuenta esa licencia al redistribuir Zyrix o combinarlo con otros programas. Las licencias MIT y Apache 2.0 de los demás componentes son compatibles con GPL-3.0.
