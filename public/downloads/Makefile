# ==============================================================================
# Berserker v0.4.0 - Multi-Architecture C++17 Makefile
# ==============================================================================

CXX ?= g++
CXXFLAGS = -std=c++17 -O3 -Wall -Wextra -pthread -funroll-loops -flto
TARGET = berserker

# Architecture flags
ARCH ?= native

ifeq ($(ARCH), x86-64-bmi2)
    ARCH_FLAGS = -march=haswell -mavx2 -mbmi -mbmi2 -mpopcnt -msse4.2
else ifeq ($(ARCH), x86-64-avx2)
    ARCH_FLAGS = -mavx2 -mpopcnt -msse4.2
else ifeq ($(ARCH), x86-64-modern)
    ARCH_FLAGS = -mpopcnt -msse4.2
else ifeq ($(ARCH), apple-silicon)
    ARCH_FLAGS = -march=armv8.5-a+simd
else ifeq ($(ARCH), armv8)
    ARCH_FLAGS = -march=armv8-a+simd
else ifeq ($(ARCH), native)
    ARCH_FLAGS = -march=native
endif

all: $(TARGET)

$(TARGET): berserker-v0.4.0.cpp
	@echo "Compiling Berserker v0.4.0 for target [$(ARCH)] with $(CXX)..."
	$(CXX) $(CXXFLAGS) $(ARCH_FLAGS) berserker-v0.4.0.cpp -o $(TARGET)
	@echo "Build complete: ./$(TARGET)"

clean:
	rm -f $(TARGET)

.PHONY: all clean
