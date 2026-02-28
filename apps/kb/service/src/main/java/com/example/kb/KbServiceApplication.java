package com.example.kb;

import io.nats.client.Connection;
import io.nats.client.Dispatcher;
import io.nats.client.Nats;
import io.nats.client.Options;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.trace.Tracer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class KbServiceApplication {

    private static final Logger log = LoggerFactory.getLogger(KbServiceApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(KbServiceApplication.class, args);
    }

    @Bean
    public CommandLineRunner run(PageRepository repo, Tracer tracer, Meter meter) {
        return args -> {
            String natsUrl = System.getenv().getOrDefault("NATS_URL", "nats://localhost:4222");
            String natsUser = System.getenv().getOrDefault("NATS_USER", "kb-service");
            String natsPass = System.getenv().getOrDefault("NATS_PASS", "kb-service-secret");

            Connection nc = connectWithRetry(natsUrl, natsUser, natsPass);
            log.info("Connected to NATS at {}", natsUrl);

            EditingPresenceTracker tracker = new EditingPresenceTracker();
            NatsHandler handler = new NatsHandler(repo, tracker, nc, tracer, meter);

            Dispatcher dispatcher = nc.createDispatcher(handler::handle);
            dispatcher.subscribe("app.kb.>", "kb-workers");

            log.info("KB service listening on app.kb.> (queue: kb-workers)");

            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try {
                    nc.close();
                } catch (Exception e) {
                    log.warn("Error closing NATS: {}", e.getMessage());
                }
            }));

            // Keep main thread alive
            Thread.currentThread().join();
        };
    }

    private Connection connectWithRetry(String url, String user, String pass) throws Exception {
        Options opts = new Options.Builder()
                .server(url)
                .userInfo(user, pass)
                .maxReconnects(-1)
                .build();

        for (int i = 1; i <= 30; i++) {
            try {
                return Nats.connect(opts);
            } catch (Exception e) {
                log.warn("NATS connection attempt {}/30 failed: {}", i, e.getMessage());
                if (i == 30) throw e;
                Thread.sleep(2000);
            }
        }
        throw new RuntimeException("unreachable");
    }
}
