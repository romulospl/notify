// Package relay valida o evento do script e o repassa ao /api/send do Umami.
//
// O payload repassado é montado de novo, só com os campos permitidos. Campos
// que o Umami aceitaria do cliente e que mudariam a identidade da sessão ou a
// origem do evento (id, ip, userAgent, timestamp, data, browser, os...) são
// descartados aqui.
package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
)

// Tamanhos máximos, em bytes, dos campos de texto.
const (
	MaxURL      = 2048
	MaxReferrer = 2048
	MaxTitle    = 500
	MaxHostname = 253
	MaxLanguage = 35
	MaxScreen   = 16

	// Limites do evento customizado (#50).
	MaxName       = 50
	MaxDataKeys   = 10
	MaxDataKey    = 40
	MaxDataString = 100
	MaxDataNumber = 32 // caracteres do literal
)

// Payload são os campos permitidos de um page view.
type Payload struct {
	Website  string `json:"website"`
	Hostname string `json:"hostname,omitempty"`
	URL      string `json:"url"`
	Referrer string `json:"referrer,omitempty"`
	Title    string `json:"title,omitempty"`
	Language string `json:"language,omitempty"`
	Screen   string `json:"screen,omitempty"`

	// Evento customizado (#50): Name e Data só são repassados depois de validados
	// em validate. Data guarda só string, número (json.Number) e booleano.
	Name string         `json:"name,omitempty"`
	Data map[string]any `json:"data,omitempty"`
}

// Proof é a prova de execução de JS que vem com o evento (#25). Nunca é
// repassada ao Umami.
type Proof struct {
	Token string `json:"t"`
	Nonce string `json:"n"`
}

// Event é o envelope que o script envia. O Umami recebe só Type e Payload.
type Event struct {
	Type    string  `json:"type"`
	Payload Payload `json:"payload"`
	Proof   Proof   `json:"p"`
}

// ErrInvalid indica um evento fora do formato aceito.
var ErrInvalid = errors.New("relay: evento inválido")

// Decode lê um evento JSON. Campos desconhecidos são ignorados, o que já tira
// do payload tudo o que não está em Payload.
func Decode(r io.Reader) (Event, error) {
	var ev Event
	dec := json.NewDecoder(r)
	// Números ficam como json.Number: o valor repassado é o enviado, sem arredondar.
	dec.UseNumber()
	if err := dec.Decode(&ev); err != nil {
		return Event{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if dec.More() {
		return Event{}, fmt.Errorf("%w: conteúdo depois do JSON", ErrInvalid)
	}
	if err := ev.validate(); err != nil {
		return Event{}, err
	}
	ev.Payload.Website = strings.ToLower(ev.Payload.Website)
	return ev, nil
}

func (ev Event) validate() error {
	p := ev.Payload
	switch {
	case ev.Type != "event":
		return fmt.Errorf("%w: type deve ser \"event\"", ErrInvalid)
	case !IsUUID(p.Website):
		return fmt.Errorf("%w: website deve ser um UUID", ErrInvalid)
	case p.URL == "":
		return fmt.Errorf("%w: url é obrigatória", ErrInvalid)
	}
	limits := []struct {
		name, v string
		max     int
	}{
		{"url", p.URL, MaxURL},
		{"referrer", p.Referrer, MaxReferrer},
		{"title", p.Title, MaxTitle},
		{"hostname", p.Hostname, MaxHostname},
		{"language", p.Language, MaxLanguage},
		{"screen", p.Screen, MaxScreen},
	}
	for _, l := range limits {
		if len(l.v) > l.max {
			return fmt.Errorf("%w: %s passa de %d bytes", ErrInvalid, l.name, l.max)
		}
	}
	return validateCustom(p)
}

var (
	namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
	keyPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// validateCustom confere o nome e as propriedades de um evento customizado.
// Nome curto de charset restrito; até MaxDataKeys propriedades com valor string
// (até MaxDataString bytes), número ou booleano. Aninhado, nulo e lista são recusados.
func validateCustom(p Payload) error {
	if p.Name == "" {
		if len(p.Data) > 0 {
			return fmt.Errorf("%w: data exige name", ErrInvalid)
		}
		return nil
	}
	if len(p.Name) > MaxName || !namePattern.MatchString(p.Name) {
		return fmt.Errorf("%w: name fora do formato", ErrInvalid)
	}
	if len(p.Data) > MaxDataKeys {
		return fmt.Errorf("%w: data passa de %d propriedades", ErrInvalid, MaxDataKeys)
	}
	for k, v := range p.Data {
		if len(k) > MaxDataKey || !keyPattern.MatchString(k) {
			return fmt.Errorf("%w: chave de data fora do formato", ErrInvalid)
		}
		switch x := v.(type) {
		case string:
			if len(x) > MaxDataString {
				return fmt.Errorf("%w: valor de data passa de %d bytes", ErrInvalid, MaxDataString)
			}
		case json.Number:
			// Literal curto e finito: o Umami pode recusar o resto e o 502 gastaria vaga.
			f, err := x.Float64()
			if len(x) > MaxDataNumber || err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
				return fmt.Errorf("%w: número de data fora do formato", ErrInvalid)
			}
		case bool:
		default:
			return fmt.Errorf("%w: valor de data deve ser string, número ou booleano", ErrInvalid)
		}
	}
	return nil
}

// IsUUID confere o formato canônico 8-4-4-4-12 em hexadecimal.
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// Client repassa eventos ao Umami.
type Client struct {
	sendURL      string
	heartbeatURL string
	ipHeader     string
	http         *http.Client
}

// NewClient aponta para base/api/send e envia o IP truncado em ipHeader.
func NewClient(base *url.URL, ipHeader string, hc *http.Client) *Client {
	return &Client{
		sendURL:      base.JoinPath("api", "send").String(),
		heartbeatURL: base.JoinPath("api", "heartbeat").String(),
		ipHeader:     ipHeader,
		http:         hc,
	}
}

// Heartbeat confere que o Umami responde em /api/heartbeat.
func (c *Client) Heartbeat(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.heartbeatURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &UpstreamError{Status: resp.StatusCode}
	}
	return nil
}

// UpstreamError é uma resposta fora de 2xx do Umami.
type UpstreamError struct{ Status int }

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("relay: umami respondeu %d", e.Status)
}

// Send repassa ev com o User-Agent original e o IP já truncado.
// Nenhum outro header do cliente é repassado.
func (c *Client) Send(ctx context.Context, ev Event, userAgent string, truncatedIP netip.Addr) error {
	body, err := json.Marshal(struct {
		Type    string  `json:"type"`
		Payload Payload `json:"payload"`
	}{ev.Type, ev.Payload})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sendURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Sem o header, o Go mandaria o próprio User-Agent e o Umami não
	// conseguiria detectar bots.
	req.Header["User-Agent"] = []string{userAgent}
	req.Header.Set(c.ipHeader, truncatedIP.String())

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &UpstreamError{Status: resp.StatusCode}
	}
	return nil
}
