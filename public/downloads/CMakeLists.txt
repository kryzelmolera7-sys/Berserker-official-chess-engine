cmake_minimum_required(VERSION 3.16)
project(Berserker VERSION 0.4.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Optimization flags
if(MSVC)
    add_compile_options(/O2 /Oi /Ot /GL /arch:AVX2 /W3)
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /LTCG")
else()
    add_compile_options(-O3 -pthread -flto -funroll-loops)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
        add_compile_options(-mavx2 -mpopcnt -msse4.2)
    elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "arm|aarch64")
        add_compile_options(-march=armv8-a+simd)
    endif()
endif()

add_executable(berserker berserker-v0.4.0.cpp)

if(NOT MSVC)
    target_link_libraries(berserker pthread)
endif()
