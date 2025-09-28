package main

import (
	"log"

	"Chatbot-Go/internal/transport"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	transport.RegisterTransportRoutes(r)

	log.Println("Gateway server started at :8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("Failed to run server: %v", err)
	}
}
