FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /app
COPY apps/kb/service/pom.xml .
RUN mvn dependency:go-offline -B
COPY apps/kb/service/src ./src
RUN mvn package -DskipTests -B

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
