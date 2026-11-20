package ingestkeyauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/extension/extensionauth"
)

// Type is the extension's name in the collector configuration.
var Type = component.MustNewType("ingestkeyauth")

// Config of the extension.
type Config struct {
	// DatabaseURL points to the stellytics database with the stellytics_collector user.
	DatabaseURL string `mapstructure:"database_url"`
	// CacheTTL is how long an answer (positive or negative) stays in memory. At
	// most 60 s, so that a revocation takes effect within 1 minute (#59).
	CacheTTL time.Duration `mapstructure:"cache_ttl"`
}

// Validate implements component.ConfigValidator.
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return errors.New("database_url is required")
	}
	if c.CacheTTL < 0 || c.CacheTTL > time.Minute {
		return fmt.Errorf("cache_ttl must be between 0 and 1m, got %s", c.CacheTTL)
	}
	return nil
}

// NewFactory creates the extension's factory.
func NewFactory() extension.Factory {
	return extension.NewFactory(Type, createDefaultConfig, create, component.StabilityLevelDevelopment)
}

func createDefaultConfig() component.Config {
	return &Config{CacheTTL: time.Minute}
}

func create(_ context.Context, set extension.Settings, cfg component.Config) (extension.Extension, error) {
	return &ext{cfg: cfg.(*Config), set: set}, nil
}

// ext ties the authenticator to the collector's lifecycle: it opens the
// database pool on Start and closes it on Shutdown.
type ext struct {
	cfg  *Config
	set  extension.Settings
	pool *pgxpool.Pool
	auth *authenticator
}

var _ extensionauth.Server = (*ext)(nil)

func (e *ext) Start(ctx context.Context, _ component.Host) error {
	pool, err := pgxpool.New(ctx, e.cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("ingestkeyauth: database_url: %w", err)
	}
	e.pool = pool
	e.auth = newAuthenticator(pgStore{pool: pool}, e.cfg.CacheTTL, e.set.Logger)
	return nil
}

func (e *ext) Shutdown(context.Context) error {
	if e.pool != nil {
		e.pool.Close()
	}
	return nil
}

func (e *ext) Authenticate(ctx context.Context, headers map[string][]string) (context.Context, error) {
	return e.auth.Authenticate(ctx, headers)
}
