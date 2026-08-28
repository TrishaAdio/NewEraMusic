// Command voice is the audio sidecar.
//
// It exists for exactly one reason: ntgcalls, the C++/WebRTC engine that every
// modern Telegram group-call client is built on, ships bindings for Python, Go,
// C and Java — and explicitly none for Node. From its README: "We removed
// anything that could burden the library, including NodeJS". The old JavaScript
// options (tgcalls, gram-tgcalls) were last published in 2021 and predate the
// current group-call protocol.
//
// So the WebRTC boundary lives here, in Go, and nowhere else. This binary holds
// call connections and moves bytes. It has no concept of a queue, a track, a
// user, a permission, or a command — all of that is TypeScript. Keeping the
// surface this thin is deliberate: it is the part that is painful to change, so
// it is the part that should almost never need to.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	voicev1 "github.com/TrishaAdio/NewEraMusic/apps/voice/gen/voicev1"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLevel(os.Getenv("LOG_LEVEL")),
	}))
	slog.SetDefault(logger)

	addr := envOr("VOICE_LISTEN_ADDR", "127.0.0.1:50051")

	engine, err := NewEngine(EngineConfig{
		APIID:   mustAtoi("TG_API_ID"),
		APIHash: mustEnv("TG_API_HASH"),
		Session: mustEnv("TG_SESSION"),
		Logger:  logger,
	})
	if err != nil {
		logger.Error("engine init failed", "err", err)
		os.Exit(1)
	}

	srv := grpc.NewServer(
		grpc.KeepaliveEnforcementPolicy(keepalivePolicy()),
		grpc.MaxConcurrentStreams(256),
	)

	service := &voiceService{engine: engine, logger: logger}
	voicev1.RegisterVoiceServiceServer(srv, service)

	// The TypeScript side gates traffic on this rather than retrying blindly
	// against a sidecar that is still bringing WebRTC up.
	hs := health.NewServer()
	healthpb.RegisterHealthServer(srv, hs)
	hs.SetServingStatus("newera.voice.v1.VoiceService", healthpb.HealthCheckResponse_SERVING)

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		logger.Error("listen failed", "addr", addr, "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("voice sidecar listening", "addr", addr)
		if err := srv.Serve(lis); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			logger.Error("serve failed", "err", err)
		}
	}()

	<-ctx.Done()

	// Leave every call before dying. Without this, Telegram holds the userbot in
	// the call for minutes and the next join is rejected as already-present.
	logger.Info("shutting down, leaving active calls")
	hs.SetServingStatus("newera.voice.v1.VoiceService", healthpb.HealthCheckResponse_NOT_SERVING)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := engine.Shutdown(shutdownCtx); err != nil {
		logger.Warn("engine shutdown incomplete", "err", err)
	}

	stopped := make(chan struct{})
	go func() { srv.GracefulStop(); close(stopped) }()
	select {
	case <-stopped:
	case <-shutdownCtx.Done():
		srv.Stop()
	}
	logger.Info("stopped")
}

// voiceService adapts the gRPC surface onto Engine. It holds no state beyond
// the event fan-out, so every RPC is safe to call concurrently.
type voiceService struct {
	voicev1.UnimplementedVoiceServiceServer

	engine *Engine
	logger *slog.Logger

	mu   sync.RWMutex
	subs map[chan *voicev1.Event]struct{}
}

func (s *voiceService) Join(ctx context.Context, req *voicev1.JoinRequest) (*voicev1.JoinResponse, error) {
	sessionID, err := s.engine.Join(ctx, req.GetChatId(), specFrom(req.GetMedia()), req.GetStartPaused())
	if err != nil {
		return nil, fmt.Errorf("join chat %d: %w", req.GetChatId(), err)
	}
	return &voicev1.JoinResponse{SessionId: sessionID}, nil
}

func (s *voiceService) Leave(ctx context.Context, req *voicev1.LeaveRequest) (*voicev1.LeaveResponse, error) {
	if err := s.engine.Leave(ctx, req.GetChatId()); err != nil {
		return nil, fmt.Errorf("leave chat %d: %w", req.GetChatId(), err)
	}
	return &voicev1.LeaveResponse{}, nil
}

func (s *voiceService) Play(ctx context.Context, req *voicev1.PlayRequest) (*voicev1.PlayResponse, error) {
	if err := s.engine.Play(ctx, req.GetChatId(), specFrom(req.GetMedia())); err != nil {
		return nil, fmt.Errorf("play chat %d: %w", req.GetChatId(), err)
	}
	return &voicev1.PlayResponse{}, nil
}

func (s *voiceService) SetPaused(ctx context.Context, req *voicev1.SetPausedRequest) (*voicev1.SetPausedResponse, error) {
	if err := s.engine.SetPaused(ctx, req.GetChatId(), req.GetPaused()); err != nil {
		return nil, err
	}
	return &voicev1.SetPausedResponse{}, nil
}

func (s *voiceService) Seek(ctx context.Context, req *voicev1.SeekRequest) (*voicev1.SeekResponse, error) {
	if err := s.engine.Seek(ctx, req.GetChatId(), time.Duration(req.GetPositionMs())*time.Millisecond); err != nil {
		return nil, err
	}
	return &voicev1.SeekResponse{}, nil
}

func (s *voiceService) SetVolume(ctx context.Context, req *voicev1.SetVolumeRequest) (*voicev1.SetVolumeResponse, error) {
	if err := s.engine.SetVolume(ctx, req.GetChatId(), int(req.GetVolume())); err != nil {
		return nil, err
	}
	return &voicev1.SetVolumeResponse{}, nil
}

func (s *voiceService) Status(ctx context.Context, req *voicev1.StatusRequest) (*voicev1.StatusResponse, error) {
	return s.engine.Status(ctx, req.GetChatId())
}

// Events fans engine events out to every connected control plane. A slow or
// dead consumer is dropped rather than allowed to block the engine — losing
// events for one client is strictly better than stalling audio for all of them.
func (s *voiceService) Events(_ *voicev1.EventsRequest, stream voicev1.VoiceService_EventsServer) error {
	ch := make(chan *voicev1.Event, 64)

	s.mu.Lock()
	if s.subs == nil {
		s.subs = make(map[chan *voicev1.Event]struct{})
	}
	s.subs[ch] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()

	unsubscribe := s.engine.Subscribe(func(ev *voicev1.Event) {
		select {
		case ch <- ev:
		default:
			s.logger.Warn("event dropped, consumer too slow", "chat_id", ev.GetChatId())
		}
	})
	defer unsubscribe()

	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case ev := <-ch:
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}
