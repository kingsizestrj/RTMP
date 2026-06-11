# 📡 RTMP Panel

Servidor RTMP com painel de gerência web. Permite:

- **🎬 Acervo de vídeos** — upload de vídeos pelo painel (drag & drop, multi-arquivo, barra de progresso)
- **📺 Canais (playlist em loop)** — monte uma playlist com os vídeos enviados e o servidor gera um link RTMP que reproduz tudo em loop infinito, 24/7, como um canal de TV
- **🔁 Relays** — informe um link HTTP/HLS/RTMP/RTSP/SRT/UDP e ele é retransmitido como um novo link RTMP (com opção de loop para VOD)
- **🎥 Entradas ao vivo** — gere chaves de stream para publicar do OBS/encoder e distribuir pelo link gerado
- **👁 Preview no navegador** — assista qualquer stream direto no painel (HTTP-FLV + flv.js)
- **📜 Logs em tempo real** — veja a saída do FFmpeg de cada canal/relay no painel
- **⚡ Autostart e auto-restart** — canais marcados sobem junto com o servidor; se o FFmpeg cair, reinicia sozinho com backoff exponencial
- **🔀 Modo aleatório** — embaralha a ordem da playlist a cada ciclo
- **🔐 Login** — painel protegido por usuário/senha; publicações RTMP só são aceitas com chaves cadastradas

## Requisitos

- **Node.js 18+**
- **FFmpeg** (e ffprobe) instalados no servidor:
  ```bash
  # Debian/Ubuntu
  sudo apt install ffmpeg
  ```

## Instalação

```bash
git clone <este-repo>
cd RTMP
npm install
cp .env.example .env   # edite ADMIN_USER/ADMIN_PASS e PUBLIC_HOST
npm start
```

- Painel web: `http://SEU_IP:3000` (login padrão `admin` / `admin` — **troque no `.env`!**)
- RTMP: `rtmp://SEU_IP:1935/live/<chave>`
- HTTP-FLV (preview/players web): `http://SEU_IP:8000/live/<chave>.flv`

### Docker

```bash
docker compose up -d --build
```

O compose já inclui FFmpeg na imagem e persiste `data/` e `media/` em volumes.

## Como usar

1. **Suba vídeos** na aba *Vídeos* (arraste arquivos ou clique em Enviar).
2. **Crie um canal** na aba *Canais*, adicione os vídeos na ordem desejada e clique em **Iniciar**.
3. Copie o link **RTMP** gerado — ele fica reproduzindo a playlist em loop. Use em qualquer player (VLC: *Mídia → Abrir transmissão de rede*) ou aponte como fonte para outra plataforma.
4. Para **retransmitir um link HTTP** (m3u8, mp4, outra live), crie um *Relay* com a URL de origem — o painel gera o link RTMP de saída. Marque *loop* se a origem for um arquivo de vídeo.
5. Para **transmitir ao vivo do OBS**, crie uma *Entrada*, configure o OBS com o servidor `rtmp://SEU_IP:1935/live` e a chave gerada.

### Modos de saída dos canais

- **Transcodificar** (padrão): re-encoda tudo para H.264/AAC na resolução/bitrate escolhidos. Funciona com qualquer mistura de vídeos, transições suaves entre eles.
- **Cópia direta**: não re-encoda (zero uso de CPU), mas exige que **todos os vídeos da playlist tenham o mesmo codec, resolução e parâmetros** — caso contrário o stream quebra na troca de vídeo.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PANEL_PORT` | `3000` | Porta do painel web |
| `RTMP_PORT` | `1935` | Porta RTMP |
| `HTTP_MEDIA_PORT` | `8000` | Porta HTTP-FLV (preview) |
| `PUBLIC_HOST` | *(host da requisição)* | Host/IP exibido nas URLs do painel |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | Credenciais do painel |
| `SESSION_SECRET` | *(aleatório)* | Segredo do cookie de sessão (defina para manter login entre restarts) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Caminho dos binários |
| `MAX_UPLOAD_MB` | `4096` | Tamanho máximo por arquivo de upload |
| `ALLOW_ANY_PUBLISH` | `false` | Aceitar publicação RTMP com qualquer chave |

## Arquitetura

```
┌─────────────┐   upload    ┌──────────────┐
│ Painel web  │────────────▶│ media/uploads │
│ (Express,   │             └──────┬───────┘
│  porta 3000)│  gerencia          │ concat + loop
└──────┬──────┘──────────┐         ▼
       │            ┌────┴─────────────┐  push   ┌─────────────────┐
       │            │ FFmpeg (1/canal, │────────▶│ node-media-server│
       ▼            │ 1/relay)         │  rtmp   │ RTMP :1935       │
  data/db.json      └──────────────────┘         │ HTTP-FLV :8000   │
                                                 └─────────────────┘
                                                   ▲            │
                                          OBS ─────┘            ▼
                                                        players / VLC /
                                                        restream / flv.js
```

Cada canal/relay ativo é um processo FFmpeg supervisionado pelo app (logs, restart automático, parada limpa). O estado fica em `data/db.json` — sem banco de dados externo.

## Segurança

- Troque `ADMIN_PASS` antes de expor o painel.
- O painel roda em HTTP puro; para acesso pela internet, coloque atrás de um reverse proxy com TLS (nginx/caddy).
- Publicações RTMP com chave desconhecida são rejeitadas (a menos que `ALLOW_ANY_PUBLISH=true`).
- A reprodução (play) dos streams é aberta — qualquer pessoa com o link assiste. Se precisar restringir, filtre as portas 1935/8000 no firewall.
