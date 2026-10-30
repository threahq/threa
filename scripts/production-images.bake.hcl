target "images" {
  name = service
  matrix = {
    service = ["backend", "control-plane", "db-read-proxy", "enclave"]
  }
  context = "."
  dockerfile = "Dockerfile.${service}"
  tags = ["threa-production-smoke:${service}"]
  cache-from = ["type=gha,scope=production-${service}"]
  cache-to = ["type=gha,mode=max,scope=production-${service}"]
  output = ["type=docker"]
}
