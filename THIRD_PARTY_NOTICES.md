# Avisos de terceros

## Tabla de tokens de WhatsApp Binary

`src/constants.js` contiene la tabla de tokens de protocolo adaptada del paquete [`@raphaelvserafim/whatsapp-binary`](https://github.com/raphaelvserafim/whatsapp-binary), versión 1.0.0, de Raphael Serafim. Se conserva localmente para que el encoder binario no necesite un paquete de tokens en tiempo de ejecución. El código fuente original se distribuye bajo MIT; se incluye el texto de esa licencia en `THIRD_PARTY_LICENSES/whatsapp-binary-MIT.txt`.

## Esquema Protocol Buffers

Zyrix usa [`@wppconnect/wa-proto`](https://github.com/wppconnect-team/wa-proto), versión 2.3000.1049217119, como dependencia para definiciones Protocol Buffers, distribuida bajo Apache License 2.0.

## Curvas elípticas

Zyrix usa [`@noble/curves`](https://github.com/paulmillr/noble-curves), de Paul Miller, para la aritmética de Ed25519 de las firmas XEdDSA. Se distribuye bajo MIT; el texto está en `THIRD_PARTY_LICENSES/noble-curves-MIT.txt`.

## Protocolo Signal

Hasta la versión 0.18.0 Zyrix dependía del paquete `libsignal` (GPL-3.0). Desde 0.19.0 X3DH, el Double Ratchet y el formato de mensajes están implementados en este repositorio a partir de las especificaciones públicas de Signal, sin código de `libsignal`. Todas las licencias de terceros que quedan (MIT, Apache 2.0 y BSD-3-Clause, esta última de `protobufjs`, que trae `@wppconnect/wa-proto`) son compatibles con la licencia MIT de Zyrix.
